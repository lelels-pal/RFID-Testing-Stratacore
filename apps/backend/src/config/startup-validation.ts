const DEFAULT_SECRETS = new Set([
  'change-me-in-production',
  'change-me-generate-with-openssl-rand-hex-32',
  'super_secret_ephemeral_jwt_key_1234',
  'master123',
  'admin123',
]);

export function validateProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;

  const required: Array<{ key: string; value?: string }> = [
    { key: 'JWT_SECRET', value: process.env.JWT_SECRET },
    { key: 'ADMIN_PASSWORD', value: process.env.ADMIN_PASSWORD },
    { key: 'MAYA_PUBLIC_KEY', value: process.env.MAYA_PUBLIC_KEY },
    { key: 'MAYA_SECRET_KEY', value: process.env.MAYA_SECRET_KEY },
  ];

  const missing = required.filter((item) => !item.value?.trim()).map((item) => item.key);
  if (missing.length > 0) {
    throw new Error(`Production startup blocked — missing env: ${missing.join(', ')}`);
  }

  const weak = required
    .filter((item) => item.value && DEFAULT_SECRETS.has(item.value.trim()))
    .map((item) => item.key);

  if (weak.length > 0) {
    throw new Error(`Production startup blocked — weak/default env values: ${weak.join(', ')}`);
  }

  if (process.env.MAYA_ENV === 'sandbox') {
    throw new Error('Production startup blocked — MAYA_ENV must not be sandbox in production.');
  }
}
