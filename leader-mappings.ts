export const LEADER_MAPPINGS = {
  f: "flameframe",
  m: "mailbox",
  r: "reload",
  y: "yosoi",
  d: "details",
} as const;

export type LeaderAction = (typeof LEADER_MAPPINGS)[keyof typeof LEADER_MAPPINGS];
