import { MavenService } from '../src/services/maven-service';

describe('MavenService version projection', () => {
    it('projects raw POM attributes, checksums, signatures, and dependency links', async () => {
        const service = new MavenService({ cacheDir: 'cache' });

        jest.spyOn(service, 'fetchVersionSummary').mockResolvedValue({
            id: 'org.example:demo:1.0.0',
            g: 'org.example',
            a: 'demo',
            v: '1.0.0',
            latestVersion: '1.0.0',
            repositoryId: 'central',
            p: 'jar',
            timestamp: 1720000000000,
            versionCount: 1,
            ec: ['.pom', '.jar', '-sources.jar']
        });

        jest.spyOn(service as any, 'fetchPomProject').mockResolvedValue({
            name: 'Demo Library',
            description: 'Example description',
            url: 'https://example.org/demo',
            packaging: 'jar',
            parent: {
                groupId: 'org.example',
                artifactId: 'parent',
                version: '2.0.0',
                relativePath: '../pom.xml'
            },
            organization: {
                name: 'Example Org',
                url: 'https://example.org'
            },
            developers: {
                developer: {
                    id: 'dev1',
                    name: 'Dev One',
                    email: 'dev1@example.org',
                    url: 'https://example.org/dev1'
                }
            },
            licenses: {
                license: {
                    name: 'Apache-2.0',
                    url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
                    distribution: 'repo',
                    comments: 'Example'
                }
            },
            scm: {
                url: 'https://github.com/example/demo',
                connection: 'scm:git:https://github.com/example/demo.git',
                developerConnection: 'scm:git:ssh://git@github.com/example/demo.git'
            },
            issueManagement: {
                system: 'GitHub',
                url: 'https://github.com/example/demo/issues'
            },
            modules: {
                module: ['core', 'cli']
            },
            properties: {
                'java.version': '17',
                'project.build.sourceEncoding': 'UTF-8'
            },
            profiles: {
                profile: {
                    id: 'release',
                    activation: {
                        activeByDefault: 'true',
                        jdk: '[17,)',
                        property: {
                            name: 'env',
                            value: 'prod'
                        }
                    }
                }
            },
            dependencies: {
                dependency: {
                    groupId: 'org.other',
                    artifactId: 'dep',
                    version: '[1.0,2.0)',
                    classifier: 'tests',
                    type: 'jar',
                    scope: 'test',
                    optional: 'true',
                    exclusions: {
                        exclusion: {
                            groupId: '*',
                            artifactId: '*'
                        }
                    }
                }
            },
            dependencyManagement: {
                dependencies: {
                    dependency: {
                        groupId: 'org.bom',
                        artifactId: 'demo-bom',
                        version: '1.0.0',
                        type: 'pom',
                        scope: 'import'
                    }
                }
            }
        });

        jest.spyOn(service, 'packageExists').mockImplementation(async (groupId, artifactId) => (
            (groupId === 'org.example' && artifactId === 'parent') ||
            (groupId === 'org.other' && artifactId === 'dep') ||
            (groupId === 'org.bom' && artifactId === 'demo-bom')
        ));
        jest.spyOn(service, 'fetchAllNamespaceIds').mockResolvedValue(['org.example', 'org.other', 'org.bom']);
        jest.spyOn(service, 'resolvePackageId').mockImplementation(async (_groupId, artifactId) => artifactId);
        jest.spyOn(service as any, 'headContentLength').mockResolvedValue(1234);
        jest.spyOn(service as any, 'fetchDigest').mockImplementation(async (...args: unknown[]) => {
            const url = String(args[0]);
            if (url.endsWith('.md5')) return '0123456789abcdef0123456789abcdef';
            if (url.endsWith('.sha1')) return '0123456789abcdef0123456789abcdef01234567';
            return undefined;
        });
        jest.spyOn(service as any, 'headExists').mockResolvedValue(true);

        const projected = await service.fetchResolvedVersion('org.example', 'demo', '1.0.0');

        expect(projected).not.toBeNull();
        expect(projected?.versionId).toBe('1.0.0');
        expect(projected?.pom_resolution).toBe('raw');
        expect(projected?.groupId).toBe('org.example');
        expect(projected?.artifactId).toBe('demo');
        expect(projected?.homepage).toBe('https://example.org/demo');
        expect(projected?.parent).toEqual({
            group_id: 'org.example',
            artifact_id: 'parent',
            version: '2.0.0',
            relative_path: '../pom.xml',
            package: '/javanamespaces/org.example/packages/parent'
        });
        expect(projected?.developers).toEqual([
            {
                id: 'dev1',
                name: 'Dev One',
                email: 'dev1@example.org',
                url: 'https://example.org/dev1'
            }
        ]);
        expect(projected?.licenses).toEqual([
            {
                name: 'Apache-2.0',
                url: 'https://www.apache.org/licenses/LICENSE-2.0.txt',
                distribution: 'repo',
                comments: 'Example'
            }
        ]);
        expect(projected?.profiles).toEqual([
            {
                id: 'release',
                active_by_default: true,
                activation_jdk: '[17,)',
                activation_property: 'env=prod'
            }
        ]);
        expect(projected?.dependencies).toEqual([
            {
                group_id: 'org.other',
                artifact_id: 'dep',
                version: '[1.0,2.0)',
                classifier: 'tests',
                type: 'jar',
                scope: 'test',
                optional: true,
                exclusions: [{ group_id: '*', artifact_id: '*' }],
                package: '/javanamespaces/org.other/packages/dep'
            }
        ]);
        expect(projected?.dependency_management).toEqual([
            {
                group_id: 'org.bom',
                artifact_id: 'demo-bom',
                version: '1.0.0',
                type: 'pom',
                scope: 'import',
                package: '/javanamespaces/org.bom/packages/demo-bom'
            }
        ]);
        expect(projected?.checksums).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: 'demo-1.0.0.jar',
                extension: 'jar',
                md5: '0123456789abcdef0123456789abcdef',
                sha1: '0123456789abcdef0123456789abcdef01234567'
            })
        ]));
        expect(projected?.signatures).toEqual(expect.arrayContaining([
            expect.objectContaining({
                filename: 'demo-1.0.0.jar',
                format: 'pgp'
            })
        ]));
        expect(projected?.classifier).toBeUndefined();
        expect(projected?.classifiers).toEqual(['sources']);
        expect(projected?.createdAt).toBe('2024-07-03T09:46:40.000Z');
    });
});
