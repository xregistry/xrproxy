package org.xregistry.mavenindex;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.apache.maven.index.reader.ChunkReader;
import org.apache.maven.index.reader.IndexReader;
import org.apache.maven.index.reader.Record;
import org.apache.maven.index.reader.RecordExpander;
import org.apache.maven.index.reader.ResourceHandler;
import org.apache.maven.index.reader.resource.PathWritableResourceHandler;

public final class MavenIndexSync {
    private static final int COMMIT_BATCH_SIZE = 100_000;

    private MavenIndexSync() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 1 || args.length > 2) {
            throw new IllegalArgumentException("Usage: MavenIndexSync <cache-directory> [index-base-url]");
        }

        Path cacheDir = Path.of(args[0]).toAbsolutePath();
        URI remoteBase = URI.create(args.length == 2
                ? args[1]
                : "https://repo1.maven.org/maven2/.index/");
        Files.createDirectories(cacheDir);

        Path database = cacheDir.resolve("maven-index.sqlite");
        Path indexState = cacheDir.resolve("maven-index-state");
        Path snapshot = cacheDir.resolve("maven-namespace-index.json");
        Files.createDirectories(indexState);

        if (!Files.exists(database)) {
            Files.deleteIfExists(indexState.resolve("nexus-maven-repository-index.properties"));
        }

        PathWritableResourceHandler local = new PathWritableResourceHandler(indexState);
        ResumableResourceHandler remote = new ResumableResourceHandler(
                remoteBase,
                cacheDir.resolve("maven-index-downloads"));
        IndexReader reader = new IndexReader(local, remote);
        boolean fullRefresh = !reader.isIncremental();
        Path targetDatabase = fullRefresh
                ? cacheDir.resolve("maven-index.sqlite.tmp")
                : database;

        if (fullRefresh) {
            Files.deleteIfExists(targetDatabase);
            remote.invalidate("nexus-maven-repository-index.gz");
        }

        try {
            applyChunks(reader, targetDatabase, fullRefresh);
            if (fullRefresh) {
                Files.move(
                        targetDatabase,
                        database,
                        StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
            }
            writeSnapshot(database, snapshot, reader.getPublishedTimestamp().toInstant().toString());
            remote.delete(reader.getChunkNames());
            reader.close();
        } catch (Exception error) {
            local.close();
            remote.close();
            if (fullRefresh) {
                Files.deleteIfExists(targetDatabase);
            }
            throw error;
        }
    }

    private static void applyChunks(
            IndexReader reader,
            Path database,
            boolean fullRefresh) throws Exception {
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database)) {
            configureDatabase(connection, fullRefresh);
            createSchema(connection);
            connection.setAutoCommit(false);

            try (PreparedStatement add = connection.prepareStatement(
                            "INSERT OR IGNORE INTO versions(group_id, artifact_id, version) VALUES (?, ?, ?)");
                    PreparedStatement remove = connection.prepareStatement(
                            "DELETE FROM versions WHERE group_id = ? AND artifact_id = ? AND version = ?")) {
                RecordExpander expander = new RecordExpander();
                int pending = 0;
                for (ChunkReader chunk : reader) {
                    try (chunk) {
                        for (Map<String, String> raw : chunk) {
                            Record record = expander.apply(raw);
                            if (record.getType() == Record.Type.ARTIFACT_ADD) {
                                pending += applyArtifact(add, record);
                            } else if (record.getType() == Record.Type.ARTIFACT_REMOVE) {
                                pending += applyArtifact(remove, record);
                            }

                            if (pending >= COMMIT_BATCH_SIZE) {
                                connection.commit();
                                pending = 0;
                            }
                        }
                    }
                }
                connection.commit();
            } catch (Exception error) {
                connection.rollback();
                throw error;
            }
        }
    }

    private static int applyArtifact(PreparedStatement statement, Record record) throws SQLException {
        if (record.getString(Record.CLASSIFIER) != null) {
            return 0;
        }
        String groupId = record.getString(Record.GROUP_ID);
        String artifactId = record.getString(Record.ARTIFACT_ID);
        String version = record.getString(Record.VERSION);
        if (groupId == null || artifactId == null || version == null) {
            return 0;
        }
        statement.setString(1, groupId);
        statement.setString(2, artifactId);
        statement.setString(3, version);
        statement.executeUpdate();
        return 1;
    }

    private static void configureDatabase(Connection connection, boolean fullRefresh) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA journal_mode=" + (fullRefresh ? "OFF" : "WAL"));
            statement.execute("PRAGMA synchronous=" + (fullRefresh ? "OFF" : "NORMAL"));
            statement.execute("PRAGMA temp_store=MEMORY");
            statement.execute("PRAGMA cache_size=-65536");
        }
    }

    private static void createSchema(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute("""
                    CREATE TABLE IF NOT EXISTS versions (
                        group_id TEXT NOT NULL,
                        artifact_id TEXT NOT NULL,
                        version TEXT NOT NULL,
                        PRIMARY KEY (group_id, artifact_id, version)
                    ) WITHOUT ROWID
                    """);
        }
    }

    private static void writeSnapshot(Path database, Path snapshot, String sourceTimestamp)
            throws SQLException, IOException {
        List<NamespaceCount> namespaces = new ArrayList<>();
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database);
                Statement statement = connection.createStatement();
                ResultSet result = statement.executeQuery("""
                        SELECT group_id, COUNT(DISTINCT artifact_id)
                        FROM versions
                        GROUP BY group_id
                        ORDER BY group_id
                        """)) {
            while (result.next()) {
                namespaces.add(new NamespaceCount(result.getString(1), result.getInt(2)));
            }
        }
        writeSnapshotFile(snapshot, namespaces, sourceTimestamp);
    }

    private static void writeSnapshotFile(
            Path snapshot,
            List<NamespaceCount> namespaces,
            String sourceTimestamp) throws IOException {
        Path temporary = snapshot.resolveSibling(snapshot.getFileName() + ".tmp");
        try (BufferedWriter writer = Files.newBufferedWriter(temporary, StandardCharsets.UTF_8)) {
            writer.write("{\"generatedAt\":\"");
            writer.write(Instant.now().toString());
            writer.write("\",\"sourceTimestamp\":\"");
            writer.write(escapeJson(sourceTimestamp));
            writer.write("\",\"namespaces\":[");
            for (int index = 0; index < namespaces.size(); index++) {
                if (index > 0) {
                    writer.write(',');
                }
                NamespaceCount namespace = namespaces.get(index);
                writer.write("{\"id\":\"");
                writer.write(escapeJson(namespace.id()));
                writer.write("\",\"count\":");
                writer.write(Integer.toString(namespace.count()));
                writer.write('}');
            }
            writer.write("]}");
        }
        Files.move(
                temporary,
                snapshot,
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE);
    }

    private static String escapeJson(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private record NamespaceCount(String id, int count) {
    }

    private static final class ResumableResourceHandler implements ResourceHandler {
        private static final int MAX_ATTEMPTS = 10;
        private static final int BUFFER_SIZE = 1024 * 1024;

        private final URI baseUri;
        private final Path cacheDir;

        private ResumableResourceHandler(URI baseUri, Path cacheDir) throws IOException {
            this.baseUri = baseUri;
            this.cacheDir = cacheDir;
            Files.createDirectories(cacheDir);
        }

        @Override
        public Resource locate(String name) {
            return () -> {
                if (name.endsWith(".properties")) {
                    return baseUri.resolve(name).toURL().openStream();
                }
                return Files.newInputStream(download(name));
            };
        }

        private Path download(String name) throws IOException {
            Path completed = cacheDir.resolve(name);
            if (Files.exists(completed)) {
                return completed;
            }

            URL url = baseUri.resolve(name).toURL();
            Path partial = cacheDir.resolve(name + ".part");
            Path etagFile = cacheDir.resolve(name + ".etag");
            RemoteMetadata metadata = readMetadata(url);
            String previousEtag = Files.exists(etagFile)
                    ? Files.readString(etagFile, StandardCharsets.UTF_8)
                    : "";
            if (!previousEtag.equals(metadata.etag())) {
                Files.deleteIfExists(partial);
                Files.writeString(etagFile, metadata.etag(), StandardCharsets.UTF_8);
            }

            IOException lastError = null;
            for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                long offset = Files.exists(partial) ? Files.size(partial) : 0;
                try {
                    HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                    connection.setConnectTimeout(30_000);
                    connection.setReadTimeout(120_000);
                    connection.setRequestProperty("User-Agent", "xRegistry-Maven-Index-Sync/1.0");
                    if (offset > 0) {
                        connection.setRequestProperty("Range", "bytes=" + offset + "-");
                        if (!metadata.etag().isBlank()) {
                            connection.setRequestProperty("If-Range", metadata.etag());
                        }
                    }

                    int status = connection.getResponseCode();
                    boolean append = offset > 0 && status == HttpURLConnection.HTTP_PARTIAL;
                    if (status != HttpURLConnection.HTTP_OK && status != HttpURLConnection.HTTP_PARTIAL) {
                        throw new IOException("Index download returned HTTP " + status + " for " + url);
                    }
                    if (!append) {
                        offset = 0;
                    }

                    try (InputStream input = connection.getInputStream();
                            var output = Files.newOutputStream(
                                    partial,
                                    StandardOpenOption.CREATE,
                                    StandardOpenOption.WRITE,
                                    append ? StandardOpenOption.APPEND : StandardOpenOption.TRUNCATE_EXISTING)) {
                        input.transferTo(output);
                    } finally {
                        connection.disconnect();
                    }

                    long downloaded = Files.size(partial);
                    if (metadata.length() >= 0 && downloaded != metadata.length()) {
                        throw new IOException(
                                "Incomplete index download: expected " + metadata.length() + " bytes, got " + downloaded);
                    }
                    Files.move(
                            partial,
                            completed,
                            StandardCopyOption.REPLACE_EXISTING,
                            StandardCopyOption.ATOMIC_MOVE);
                    Files.deleteIfExists(etagFile);
                    return completed;
                } catch (IOException error) {
                    lastError = error;
                    if (attempt < MAX_ATTEMPTS) {
                        try {
                            Thread.sleep(Math.min(30_000L, attempt * 2_000L));
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IOException("Index download interrupted", interrupted);
                        }
                    }
                }
            }
            throw lastError == null ? new IOException("Index download failed for " + url) : lastError;
        }

        private RemoteMetadata readMetadata(URL url) throws IOException {
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("HEAD");
            connection.setConnectTimeout(30_000);
            connection.setReadTimeout(30_000);
            connection.setRequestProperty("User-Agent", "xRegistry-Maven-Index-Sync/1.0");
            try {
                int status = connection.getResponseCode();
                if (status != HttpURLConnection.HTTP_OK) {
                    throw new IOException("Index metadata returned HTTP " + status + " for " + url);
                }
                String etag = connection.getHeaderField("ETag");
                return new RemoteMetadata(etag == null ? "" : etag, connection.getContentLengthLong());
            } finally {
                connection.disconnect();
            }
        }

        private void invalidate(String name) throws IOException {
            Files.deleteIfExists(cacheDir.resolve(name));
        }

        private void delete(List<String> names) throws IOException {
            for (String name : names) {
                Files.deleteIfExists(cacheDir.resolve(name));
                Files.deleteIfExists(cacheDir.resolve(name + ".part"));
                Files.deleteIfExists(cacheDir.resolve(name + ".etag"));
            }
        }

        private record RemoteMetadata(String etag, long length) {
        }
    }
}
