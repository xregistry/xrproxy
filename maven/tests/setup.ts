jest.setTimeout(30000);

const originalConsole = global.console;

beforeAll(() => {
    global.console = {
        ...originalConsole,
        log: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    };
});

afterAll(() => {
    global.console = originalConsole;
});

export {};
