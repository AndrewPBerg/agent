export const LEADER_MAPPINGS = {
  " ": "session-text",
  f: "flameframe",
  m: "mailbox",
  r: "reload",
  u: "usage",
  y: "yosoi",
  d: "details",
} as const;

export type LeaderAction = (typeof LEADER_MAPPINGS)[keyof typeof LEADER_MAPPINGS];
