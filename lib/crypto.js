// Criptografia simetrica para tokens de integracao (Notion / Google).
// AES-256-GCM. A chave vem de INTEGRATIONS_ENC_KEY (qualquer string) e e
// derivada via SHA-256 -> sempre 32 bytes, entao nao importa o tamanho que
// o usuario configurar. Formato de saida: base64(iv).base64(tag).base64(ct)
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function getKey() {
  const secret = process.env.INTEGRATIONS_ENC_KEY;
  if (!secret) {
    throw new Error('INTEGRATIONS_ENC_KEY nao configurada - necessaria para integracoes');
  }
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(payload) {
  if (payload == null) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 3) throw new Error('Payload encriptado invalido');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
