import { hashPassword } from './auth.js';

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error('用法: npm run password:hash -- "至少10位的新密码"');
  process.exit(1);
}
console.log(await hashPassword(password));
