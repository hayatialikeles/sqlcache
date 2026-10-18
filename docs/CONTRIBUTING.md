# Contributing to MySQL Redis Cache Connector

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

1. Check existing issues and discussions
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
   npm install
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

- Node.js 14+ 
- MySQL 5.7+
- Redis 3+

### Local Setup

```bash
# Clone repository
git clone https://github.com/hayatialikeles/sqlcache.git
cd sqlcache

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your database credentials
nano .env

# Run tests
npm test

# Run with coverage
npm run coverage
```

### Environment Configuration

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
CORE_AUTO_FEATURES=true
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
```

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

### Enable Debug Logs

```javascript
// Add to your code
process.env.DEBUG = 'mysql-cache:*';
```

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
# Clear cache
redis-cli FLUSHALL

# Reset test database
mysql -u root -p test_db < schema.sql
```

## 📋 Checklist Before PR

- [ ] All tests pass (`npm test`)
- [ ] Coverage is >95% (`npm run coverage`)
- [ ] Documentation updated
- [ ] TypeScript definitions updated
- [ ] Commit messages follow convention
- [ ] No breaking changes (or clearly documented)
- [ ] Examples added for new features

## 🚀 Release Process

(For maintainers only)

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Run tests: `npm test`
4. Commit: `git commit -m "chore: release v2.x.x"`
5. Tag: `git tag v2.x.x`
6. Push: `git push && git push --tags`
7. Publish: `npm publish`

## 💬 Communication

- **Issues**: Bug reports and feature requests
- **Discussions**: General questions and ideas
- **Email**: For security issues only

## 📜 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing! 🎉**
