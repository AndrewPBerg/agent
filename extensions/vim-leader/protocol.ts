import type { LeaderAction } from "../../leader-mappings";

export const VIM_LEADER_EVENT = "vim-leader:invoke";

export type VimLeaderInvocation = {
  sequence: string;
  action: LeaderAction;
};
