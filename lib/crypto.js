/**
 * dsh-sync 加密模块 —— AES-256-GCM + scrypt 密钥包装。
 *
 * 设计：
 *   - 主密钥 K：32 字节随机数。
 *   - 文件加密：每个文件独立随机 12 字节 IV，GCM 认证；输出 = MAGIC(5) + IV(12) + TAG(16) + 密文。
 *   - 密钥包装：K 用 passphrase 派生 KEK(scrypt, N=2^15) 加密后存 key.enc 入库；
 *              本机另缓存明文 K 于 ~/.dsh/dsh-sync/key（不入库）。
 *   - 复杂度可调：scryptN / scryptR / scryptP 由 config 控制（用户以后可加大强度）。
 */
import {
  createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash, createHmac,
} from 'node:crypto';

const FILE_MAGIC = Buffer.from('DSHX1');
const KEY_MAGIC = Buffer.from('DSHK1');

export const DEFAULT_KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 192 * 1024 * 1024 };

/** 生成新的 32 字节主密钥。 */
export function newMasterKey() {
  return randomBytes(32);
}

/** scrypt 派生 KEK。 */
export function deriveKek(passphrase, salt, kdf = DEFAULT_KDF, keyLen = 32) {
  return scryptSync(passphrase, salt, keyLen, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: kdf.maxmem || DEFAULT_KDF.maxmem,
  });
}

/** 用 passphrase 包装（加密）主密钥 → 入库的 key.enc 内容。 */
export function wrapKey(masterKey, passphrase, kdf = DEFAULT_KDF) {
  const salt = randomBytes(16);
  const kek = deriveKek(passphrase, salt, kdf);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(masterKey), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([KEY_MAGIC, salt, iv, tag, ct]);
}

/** 解开 key.enc，取回主密钥。 */
export function unwrapKey(blob, passphrase, kdf = DEFAULT_KDF) {
  if (!Buffer.isBuffer(blob) || blob.length < 5 + 16 + 12 + 16) throw new Error('key.enc 格式无效');
  if (!blob.subarray(0, 5).equals(KEY_MAGIC)) throw new Error('key.enc 魔数不符');
  const salt = blob.subarray(5, 21);
  const iv = blob.subarray(21, 33);
  const tag = blob.subarray(33, 49);
  const ct = blob.subarray(49);
  const kek = deriveKek(passphrase, salt, kdf);
  const d = createDecipheriv('aes-256-gcm', kek, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/**
 * 确定性 IV：IV = HMAC-SHA256(K, 明文)[0:12]。
 *
 * 为什么不用随机 IV：随机 IV 会让「内容没变的密文」每次同步都变成新字节，于是
 * 每次推送都产生一条 diff/提交（历史被无谓刷屏、远端体积增长）。改成确定性 IV 后
 * 同样的明文 → 同样的密文，内容未变就不产生任何变化；不同明文的 IV 由 HMAC 决定，
 * 碰撞概率可忽略，满足 GCM 的 (key, IV) 唯一性要求。
 *
 * 兼容性：IV 存在密文里，旧版本写的随机 IV 密文照旧可以解密，无需迁移。
 */
function fileIv(masterKey, plain) {
  return createHmac('sha256', masterKey).update(plain).digest().subarray(0, 12);
}

/** 加密单个文件内容（确定性 IV，内容相同则密文相同）。 */
export function encryptFile(plain, masterKey) {
  const iv = fileIv(masterKey, plain);
  const c = createCipheriv('aes-256-gcm', masterKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([FILE_MAGIC, iv, c.getAuthTag(), ct]);
}

/** 解密单个文件内容。 */
export function decryptFile(blob, masterKey) {
  if (!Buffer.isBuffer(blob) || blob.length < 5 + 12 + 16) throw new Error('密文格式无效');
  if (!blob.subarray(0, 5).equals(FILE_MAGIC)) throw new Error('密文魔数不符');
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const ct = blob.subarray(33);
  const d = createDecipheriv('aes-256-gcm', masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 内容 sha256（用于清单比对）。 */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 生成一个便于人眼校验的短指纹。 */
export function shortHash(buf) {
  return sha256(buf).slice(0, 12);
}
