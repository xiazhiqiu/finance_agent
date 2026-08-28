import bcrypt from "bcryptjs";
import { readUsers, readSessions, writeUsers, writeSessions, getAssignedCustomerIds } from "./store.mjs";
import { json } from "./helpers.mjs";

const SESSION_MAX_AGE = 86400; // 24小时

function parseCookies(request) {
  const cookie = request.headers.cookie;
  if (!cookie) return {};
  const result = {};
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) result[key] = decodeURIComponent(value.join("="));
  }
  return result;
}

// 返回 { managerId, role } 或 null
export async function verifySession(request) {
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (!token) return null;
  const sessions = await readSessions();
  const session = sessions[token];
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    delete sessions[token];
    await writeSessions(sessions);
    return null;
  }
  return { managerId: session.managerId, role: session.role };
}

export async function login(username, password, response) {
  const users = await readUsers();
  const user = Object.values(users).find((u) => u.username === username);
  if (!user) throw new Error("用户名或密码错误");
  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) throw new Error("用户名或密码错误");
  const token = crypto.randomUUID();
  const now = new Date();
  const session = {
    token,
    managerId: user.managerId,
    role: user.role || "manager",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE * 1000).toISOString(),
  };
  const sessions = await readSessions();
  sessions[token] = session;
  await writeSessions(sessions);
  response.setHeader("Set-Cookie", `session=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}; Path=/`);
  return { managerId: user.managerId, name: user.name, role: user.role || "manager", avatar: user.avatar || "" };
}

export async function logout(request, response) {
  const cookies = parseCookies(request);
  const token = cookies.session;
  if (token) {
    const sessions = await readSessions();
    delete sessions[token];
    await writeSessions(sessions);
  }
  response.setHeader("Set-Cookie", "session=; HttpOnly; SameSite=Strict; Max-Age=0; Path=/");
}

export async function resetPassword(managerId, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error("新密码至少需要 6 位");
  const users = await readUsers();
  const user = users[managerId];
  if (!user) throw new Error("用户不存在");
  if (!bcrypt.compareSync(oldPassword, user.password)) throw new Error("原密码错误");
  user.password = bcrypt.hashSync(newPassword, 10);
  await writeUsers(users);
}

export async function resetPasswordPublic(username, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 6) throw new Error("新密码至少需要 6 位");
  const users = await readUsers();
  const user = Object.values(users).find((u) => u.username === username);
  if (!user) throw new Error("用户不存在");
  if (!bcrypt.compareSync(oldPassword, user.password)) throw new Error("原密码错误");
  user.password = bcrypt.hashSync(newPassword, 10);
  await writeUsers(users);
}

export async function getMe(managerId) {
  const users = await readUsers();
  const user = users[managerId];
  if (!user) throw new Error("用户不存在");
  return { managerId: user.managerId, name: user.name, role: user.role || "manager", avatar: user.avatar || "" };
}

// 验证登录态，返回 { managerId, role }
export async function requireAuth(request, response, origin) {
  const session = await verifySession(request);
  if (!session) {
    json(response, 401, { error: "请先登录" }, origin);
    return null;
  }
  return session;
}

// 验证管理员权限，返回 { managerId, role }
export async function requireAdmin(request, response, origin) {
  const session = await requireAuth(request, response, origin);
  if (!session) return null;
  if (session.role !== "admin") {
    json(response, 403, { error: "需要管理员权限" }, origin);
    return null;
  }
  return session;
}

// 获取客户经理名下的客户 ID 列表
export function getAssignedCustomers(managerId) {
  return getAssignedCustomerIds(managerId);
}