

const registerSchema = {
  name: { minLength: 2, maxLength: 100 },
  email: { email: true },
  password: { minLength: 8 },
  key: { minLength: 1 },
};

const loginSchema = {
  email: { email: true },
  password: { minLength: 1 },
};

function validateSchema(schema: Record<string, { minLength?: number; maxLength?: number; email?: boolean }>, data: Record<string, unknown>): { ok: boolean; error?: string } {
  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];
    if (typeof value !== 'string' || value.length === 0) {
      return { ok: false, error: `Field ${field} is required` };
    }
    if (rules.minLength && value.length < rules.minLength) {
      return { ok: false, error: `${field} must be at least ${rules.minLength} characters` };
    }
    if (rules.maxLength && value.length > rules.maxLength) {
      return { ok: false, error: `${field} must be at most ${rules.maxLength} characters` };
    }
    if (rules.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { ok: false, error: `${field} must be a valid email` };
    }
  }
  return { ok: true };
}

describe('registerSchema validation', () => {
  it('rejects invalid email', () => {
    const result = validateSchema(registerSchema, { name: 'Test', email: 'invalid', password: '12345678', key: 'KEY-123' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('email must be a valid email');
  });

  it('rejects short password', () => {
    const result = validateSchema(registerSchema, { name: 'Test', email: 'test@test.com', password: '123', key: 'KEY-123' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('password must be at least 8 characters');
  });

  it('rejects long name', () => {
    const result = validateSchema(registerSchema, { name: 'a'.repeat(101), email: 'test@test.com', password: '12345678', key: 'KEY-123' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('name must be at most 100 characters');
  });

  it('rejects registration without key', () => {
    const result = validateSchema(registerSchema, { name: 'Test', email: 'test@test.com', password: '12345678', key: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Field key is required');
  });

  it('accepts valid registration data', () => {
    const result = validateSchema(registerSchema, { name: 'Test', email: 'test@test.com', password: '12345678', key: 'KEY-123' });
    expect(result.ok).toBe(true);
  });
});

describe('loginSchema validation', () => {
  it('rejects invalid email', () => {
    const result = validateSchema(loginSchema, { email: 'invalid', password: '123' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('email must be a valid email');
  });

  it('accepts valid login data', () => {
    const result = validateSchema(loginSchema, { email: 'test@test.com', password: '123' });
    expect(result.ok).toBe(true);
  });
});
