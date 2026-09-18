官方送检凭证：一次送检的四路互证证据都归档在这里（evidence/zhuque/）。

ledger.jsonl     追加式账本（送检文本/截图字节哈希 + 页面原文 + 手抄值）
<id>.txt          当时粘给朱雀的那段原文（seal 复制进来，哈希指向它）
<id>.png          朱雀页面截图

为什么必须入库：artifacts/ 与 scripts/zhuque-v4-out/ 都被 gitignore，
哈希若指向不入库的文件，克隆后就什么都验不了。

用法：npx tsx scripts/zhuque-evidence.ts seal --help 见 README「官方送检凭证账本」
