// Jest global setup for Packagist xRegistry wrapper tests

// Suppress console output in tests unless LOG_LEVEL=debug
if (process.env['LOG_LEVEL'] !== 'debug') {
    jest.spyOn(console, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'debug').mockImplementation(() => undefined);
}

// Increase timeout for integration-style tests
jest.setTimeout(15000);
