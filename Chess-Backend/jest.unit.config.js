module.exports = {
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/tests/security.test.js",
    "<rootDir>/tests/multiplayer.authoritative.test.js",
    "<rootDir>/tests/tournament.concurrency.test.js",
  ],
  collectCoverageFrom: ["src/**/*.js"],
};
