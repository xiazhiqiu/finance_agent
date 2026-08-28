const corsHeaders = (origin) => ({
  "access-control-allow-origin": origin || "http://127.0.0.1:4174",
  "access-control-allow-credentials": "true",
});

// 返回 true 表示已写响应，供路由 `return json(...)` 停止后续分发
const json = (response, status, body, origin) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  });
  response.end(JSON.stringify(body));
  return true;
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
};

export { corsHeaders, json, readBody };