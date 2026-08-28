// 认证路由：公开段（login/logout/reset-password-public）与登录后段（me/reset-password）
export default async function register(ctx) {
  const { request, response, url, session, origin, phase, json, readBody, auth } = ctx;

  if (phase === "public") {
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readBody(request);
      const result = await auth.login(body.username || "", body.password || "", response);
      return json(response, 200, result, origin);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      await auth.logout(request, response);
      return json(response, 200, { success: true }, origin);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/reset-password-public") {
      const body = await readBody(request);
      await auth.resetPasswordPublic(body.username || "", body.oldPassword || "", body.newPassword || "");
      return json(response, 200, { success: true }, origin);
    }
    return false;
  }

  // 登录后段（manager 相位，session 已建立）
  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    return json(response, 200, await auth.getMe(session.managerId), origin);
  }
  if (request.method === "POST" && url.pathname === "/api/auth/reset-password") {
    const body = await readBody(request);
    await auth.resetPassword(session.managerId, body.oldPassword || "", body.newPassword || "");
    return json(response, 200, { success: true }, origin);
  }

  return false;
}