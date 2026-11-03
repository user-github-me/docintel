/** Black-box API tests against a running stack: E2E_API_URL (default http://localhost:4000), E2E_API_KEY. */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }] },
  testTimeout: 240000,
};
