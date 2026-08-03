module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    testMatch: ['**/*.test.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
    },
};
