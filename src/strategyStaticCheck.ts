// 戦略コードの静的検査（ADR 0006 §5）。
// direct モードでは agent が anvil RPC に直接触れるため、無認証 cheatcode
// （anvil_setBalance / evm_mine / anvil_impersonateAccount 等）で原理上チートできる。
// LLM が戦略コードを書く運用では「自作 agent = 信頼前提」が成り立たないので、
// /strategy-evolve のゲートに「生成・編集された戦略コードに cheatcode 呼び出しが
// 含まれないことの機械検査」を入口側の防御として置く（事後監査と対）。
export type StaticCheckFinding = {
  line: number; // 1 始まり
  match: string;
  rule: string;
};

const CHEAT_PATTERNS: Array<{ rule: string; regex: RegExp }> = [
  { rule: "anvil cheatcode RPC", regex: /\banvil_[a-zA-Z]+/ },
  { rule: "evm cheatcode RPC", regex: /\bevm_[a-zA-Z]+/ },
  { rule: "hardhat cheatcode RPC", regex: /\bhardhat_[a-zA-Z]+/ },
  {
    rule: "chain.ts の特権ヘルパ（環境専用）",
    regex:
      /\b(setEthBalance|dealErc20|impersonate|stopImpersonate|sendAsImpersonated|setIntervalMining|setAutomine|resetFork)\b/,
  },
];

export function findCheatcodeUsage(source: string): StaticCheckFinding[] {
  const findings: StaticCheckFinding[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { rule, regex } of CHEAT_PATTERNS) {
      const match = lines[i].match(regex);
      if (match) findings.push({ line: i + 1, match: match[0], rule });
    }
  }
  return findings;
}
