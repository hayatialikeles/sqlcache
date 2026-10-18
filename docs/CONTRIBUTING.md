# Contributing to sqlcache

Thank you for your interest in contributing! We welcome contributions from the community.

## 🤝 How to Contribute

### Reporting Bugs

1. Check if the issue already exists in [GitHub Issues](https://github.com/hayatialikeles/sqlcache/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (Node.js version, OS, package version)
   - Code samples if applicable

### Suggesting Features

1. Check existing issues
2. Create a new issue with:
   - Clear use case description
   - Why this feature is needed
   - Proposed API design (if applicable)
   - Example usage

### Pull Requests

1. **Fork the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/sqlcache.git
   cd sqlcache
   npm ci
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/my-new-feature
   ```

3. **Make your changes**
   - Follow existing code style
   - Add tests for new features
   - Update documentation as needed
   - Ensure all tests pass

4. **Run tests**
   ```bash
   npm test
   npm run coverage
   npx -p typescript@5 tsc -p test/types   # type definitions check
   ```

5. **Commit your changes**
   ```bash
   git commit -m "feat: add amazing new feature"
   ```

6. **Push to your fork**
   ```bash
   git push origin feature/my-new-feature
   ```

7. **Create Pull Request**
   - Provide clear description
   - Link related issues
   - Ensure CI passes

## 📝 Development Setup

### Prerequisites

- Node.js 14+ for the package; the test suite runs in CI on Node 18, 20, 22, 24 and 26
- For integration tests: MySQL 5.7+ (CI uses 8.0) and Redis 2.8+ (CI uses 7), in Docker

### Local Setup

```bash
# Clone repository
git clone https://github.com/hayatialikeles/sqlcache.git
cd sqlcache

# Install dependencies (node_modules is not committed)
npm ci

# Unit tests (no MySQL or Redis needed)
npm test

# Run with coverage
npm run coverage

# Type definitions check, as run in CI
npx -p typescript@5 tsc -p test/types
```

### Environment Configuration

Unit and integration tests set the variables they need themselves. To try the package against your
own servers, copy `.env.example` to `.env` and edit it:

```bash
# Database
DB_HOST=localhost
DB_USERNAME=root
DB_PASSWORD=secret
DB_NAME=test_db
DB_PORT=3306

# Redis
REDIS_SERVER=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Features
CORE_AUTO_FEATURES=true       # automatic cache keys
CORE_AUTO_INVALIDATION=true   # automatic invalidation
```

## ✅ Testing Guidelines

### Writing Tests

- Use Mocha + Chai + Sinon
- Place tests in `test/` directory
- Follow existing test patterns
- Aim for >95% coverage

### Test Structure

```javascript
describe('Feature Name', () => {
    let stubs;

    beforeEach(() => {
        // Setup
    });

    afterEach(() => {
        // Cleanup
        sinon.restore();
    });

    it('should do something', async () => {
        // Test implementation
        expect(result).to.equal(expected);
    });
});
```

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run coverage

# Run specific test file
npx mocha test/transaction.test.js

# Integration tests: Redis on 127.0.0.1:6399, MySQL on 127.0.0.1:3399 (root / testpass / testdb).
# Container commands use DOCKER_BIN (default: docker) and REDIS_CONTAINER (default: test-redis).
INTEGRATION=1 npm test

# Chaos suites (Docker containers test-redis / test-mysql)
INTEGRATION=1 node test/chaos.test.js
INTEGRATION=1 node test/chaos-mysql.test.js
```

CI (`.github/workflows/ci.yml`) runs the unit tests on Node 18, 20, 22, 24 and 26, once more against
the minimum dependency versions (mysql2 3.23.1, redis 3.1.2, dotenv 16.0.3), the type definitions
check, and the integration tests against MySQL 8.0 and Redis 7.

## 📚 Documentation Guidelines

### Code Comments

- Use JSDoc for all public functions
- Include parameter types and return values
- Provide usage examples

```javascript
/**
 * Executes a query with automatic caching
 * @param {string} sql - SQL query
 * @param {any[]} parameters - Query parameters
 * @param {string|null} cacheName - Cache key (optional)
 * @returns {Promise<any[]>} - Query results
 * 
 * @example
 * const users = await getCacheQuery('SELECT * FROM users', []);
 */
```

### Documentation Files

- Update `README.md` for user-facing changes
- Update `docs/API.md` for API changes
- Add examples to `docs/EXAMPLES.md`
- Update TypeScript definitions in `index.d.ts`

## 🎯 Code Style

### JavaScript

- Use ES6+ features
- Prefer `async/await` over callbacks
- Use meaningful variable names
- Keep functions small and focused

### Formatting

```javascript
// Good
async function fetchUser(id) {
    const user = await getCacheQuery('SELECT * FROM users WHERE id = ?', [id]);
    return user;
}

// Avoid
async function fetchUser(id){
const user=await getCacheQuery('SELECT * FROM users WHERE id = ?',[id]);
return user;}
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add new feature`
- `fix: resolve bug in cache invalidation`
- `docs: update API documentation`
- `test: add transaction tests`
- `refactor: improve connection pool logic`
- `chore: update dependencies`

## 🐛 Debugging

### Logs

sqlcache has no debug switch. It logs connection events (Redis connects, reconnects and outages,
pool shutdown) with `console.log` / `console.error`.

### Common Issues

**Connection Errors**
```bash
# Check MySQL is running
mysql -u root -p

# Check Redis is running
redis-cli ping
```

**Test Failures**
```bash
# Clear the test Redis (integration tests use port 6399)
redis-cli -p 6399 FLUSHALL

# The integration tests create and drop their own table (test_users) in testdb
```

## 📋 Checklist Before PR

- [ ] All tests pass (`npm test`)
- [ ] Coverage is >95% (`npm run coverage`)
- [ ] Type definitions check passes (`npx -p typescript@5 tsc -p test/types`)
- [ ] Documentation updated
- [ ] TypeScript definitions updated
- [ ] Commit messages follow convention
- [ ] No breaking changes (or clearly documented)
- [ ] Examples added for new features

## 🚀 Release Process

(For maintainers only)

1. Update version in `package.json`
2. Describe the changes in `docs/MIGRATION.md`
3. Run tests: `npm test`
4. Commit: `git commit -m "chore: release v2.x.x"`
5. Tag: `git tag v2.x.x`
6. Push: `git push && git push --tags`
7. Publish: `npm publish`

## 💬 Communication

- **Issues**: Bug reports, feature requests and questions
- **Security issues**: please do not open a public issue; contact the maintainer privately

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing! 🎉**
