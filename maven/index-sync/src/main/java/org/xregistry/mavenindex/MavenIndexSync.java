package org.xregistry.mavenindex;

import java.io.BufferedWriter;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
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
import org.apache.maven.index.reader.resource.PathWritableResourceHandler;
import org.apache.maven.index.reader.resource.UriResourceHandler;

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
        UriResourceHandler remote = new UriResourceHandler(remoteBase);
        IndexReader reader = new IndexReader(local, remote);
        boolean fullRefresh = !reader.isIncremental();
        Path targetDatabase = fullRefresh
                ? cacheDir.resolve("maven-index.sqlite.tmp")
                : database;

        if (fullRefresh) {
            Files.deleteIfExists(targetDatabase);
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
}
