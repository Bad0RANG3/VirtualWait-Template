/**
 * 现场开户 CLI（管理员手动建号）。
 *
 * 用途：`REGISTRATION_ENABLED=false` 时，玩家无法自助注册，但仍需要为新玩家
 * 建号。运维人员用本脚本在本机（拥有环境文件与数据库访问权）建号，校验规则与
 * 自助注册完全一致，唯一的区别是不需要签到码（运维本人就是「在场证明」），
 * 也不消耗每 IP 注册配额。
 *
 * 用法：
 *   # 口令走 stdin，避免进入 shell 历史
 *   printf '%s' '玩家的口令' | npm run account:create -- \
 *     --username player01 --nickname "玩家一号" [--qq 12345678] [--venue sample-venue]
 *
 *   # 或（会留在 shell 历史里，仅本机调试时使用）
 *   npm run account:create -- --username player01 --nickname "玩家一号" --password '口令'
 *
 * 生产机上需要先加载 Web 的环境变量（至少 SESSION_SECRET，含数据库路径）：
 *   set -a; . /etc/virtualwait/web.env; set +a; npm run account:create -- ...
 */
import fs from "node:fs";
import { ServiceError } from "../src/lib/api";
import { createAccountAsOperator } from "../src/lib/auth/account";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const MESSAGES: Record<string, string> = {
  INVALID_USERNAME: "用户名需为 3-20 位字母、数字、下划线或短横线",
  INVALID_NICKNAME: "昵称需为 2-20 个可见字符",
  INVALID_PASSWORD: "口令无效",
  PASSWORD_TOO_SHORT: "口令至少 8 位",
  PASSWORD_TOO_LONG: "口令最多 128 位",
  PASSWORD_TOO_WEAK: "口令过于简单，请更换",
  INVALID_QQ: "QQ 号需为 5-12 位数字",
  USERNAME_TAKEN: "该用户名已存在",
  NICKNAME_TAKEN: "该昵称已被占用",
  QQ_TAKEN: "该 QQ 已绑定其他账号",
  CHECKIN_VENUE_UNKNOWN: "场地不存在（--venue 需要 catalog 里的 slug）",
};

function readPassword(): string {
  const fromArgument = argument("--password");
  if (fromArgument) return fromArgument;
  const fromEnv = process.env.VIRTUALWAIT_ACCOUNT_PASSWORD;
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    throw new Error(
      "缺少口令：用 `printf '%s' '口令' | npm run account:create -- ...` 或设置 VIRTUALWAIT_ACCOUNT_PASSWORD",
    );
  }
  return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

function main() {
  const username = argument("--username");
  const nickname = argument("--nickname");
  if (!username || !nickname) {
    throw new Error(
      "用法：npm run account:create -- --username <用户名> --nickname <昵称> [--qq <QQ>] [--venue <场地slug>]",
    );
  }

  const user = createAccountAsOperator({
    username,
    nickname,
    password: readPassword(),
    qq: argument("--qq") ?? null,
    venueSlug: argument("--venue") ?? null,
  });

  // 只输出非敏感字段，绝不回显口令。
  console.info("已创建账号", {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    qq: user.qq,
    checkinVenueId: user.checkinVenueId,
  });
}

try {
  main();
} catch (err) {
  if (err instanceof ServiceError) {
    console.error(`创建失败：${MESSAGES[err.code] || err.code}`);
  } else {
    console.error(`创建失败：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
}
