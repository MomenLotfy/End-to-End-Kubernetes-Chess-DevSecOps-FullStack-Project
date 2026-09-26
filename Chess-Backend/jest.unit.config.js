module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/tests/security.test.js",
    "<rootDir>/tests/multiplayer.authoritative.test.js",
    "<rootDir>/tests/tournament.concurrency.test.js",
    "<rootDir>/tests/observability.unit.test.js",
    "<rootDir>/tests/avatarStore.unit.test.js",
    "<rootDir>/tests/redis.unit.test.js",
    "<rootDir>/tests/rematchVotes.unit.test.js",
    "<rootDir>/tests/roomHydration.unit.test.js",
    "<rootDir>/tests/rateLimit.unit.test.js",
    "<rootDir>/tests/shutdown.unit.test.js",
  ],
  collectCoverageFrom: ["src/**/*.js"],
};
