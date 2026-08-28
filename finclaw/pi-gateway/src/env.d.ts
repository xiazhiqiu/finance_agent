/// <reference types="node" />

// pi-gateway 自定义环境变量声明
declare namespace NodeJS {
  interface ProcessEnv {
    /** pi-gateway HTTP 服务监听端口，默认 18789 */
    PI_GATEWAY_PORT?: string;
    /** pi-coding-agent 使用的 .pi 目录路径，默认相对于本目录的 ../.pi */
    PI_AGENT_DIR?: string;
    /** Agent 运行沙箱开关；缺省/"1" 启用（禁内置文件工具，仅留自定义业务工具），置 "0" 关闭（agent-session.ts） */
    FINANCE_AGENT_SANDBOX?: string;
  }
}
