// 一次性：从 GitHub HTML 抓 star / 最后 commit 时间（绕开 api.github.com 限额）
import https from "node:https";

const REPOS = [
  "blader/humanizer",
  "op7418/Humanizer-zh",
  "hardikpandya/stop-slop",
  "epoko77-ai/im-not-ai",
  "lynote-ai/humanize-text",
  "Nanako0129/sepia",
  "larashero3-dotcom/lieflat-less-ai-tone",
  "iniwap/AIWriteX",
  "MrGeDiao/shuorenhua",
  "AIScientists-Dev/academic-humanizer",
  "Raymondhou0917/speak-human-tw",
  "redbaronyyyyy-eng/humanizer-zh-academic",
  "Hyacehila/humanizer-zh-next",
  "qoqu/anti-zhuque",
  "weiyinerzui/humanize-cn",
  "pengong101/ai-humanizer-cn",
  "LifelongLazyLearner/qu-ai-wei",
  "baibanbao/qu-ai-wei",
  "petergyang/no-ai-slop",
  "KKKKhazix/human-writing",
  "zenstory-ai/oh-story-claudecode",
  "hexiecs/talk-normal",
  "fengxingxuerong/clear",
];

const UA = { "User-Agent": "Mozilla/5.0" };

function fetchRaw(host, path) {
  return new Promise((res, rej) => {
    https
      .get({ host, path, headers: UA, timeout: 30000 }, (r) => {
        let d = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (d += c));
        r.on("end", () => res(d));
        r.on("error", rej);
      })
      .on("error", rej)
      .on("timeout", function () {
        this.destroy();
        rej(new Error("timeout"));
      });
  });
}

async function repo(full) {
  let stars = -1,
    pushed = "?",
    forks = -1;
  try {
    const html = await fetchRaw("github.com", "/" + full);
    const m = html.match(/stargazerCount":(\d+)/);
    if (m) stars = +m[1];
    const f = html.match(/forkCount":(\d+)/);
    if (f) forks = +f[1];
    const arc = html.match(/"archivedAt":\s*"?([^",}\]]+)/);
    if (arc) pushed = "ARCHIVED " + arc[1].slice(0, 10);
  } catch {
    // 单个项目取不到（限流 / 重定向 / 改名）不该拖垮整轮，silent 跳过后留 stars=-1
  }
  if (pushed === "?") {
    try {
      const atom = await fetchRaw("github.com", "/" + full + "/commits.atom");
      const d = atom.match(/<updated>([^<]+)<\/updated>/);
      if (d) pushed = d[1].slice(0, 10);
    } catch {
      /* ignore */
    }
  }
  return { full, stars, forks, pushed };
}

const out = [];
for (let i = 0; i < REPOS.length; i += 6) {
  const batch = REPOS.slice(i, i + 6).map(repo);
  const rs = await Promise.all(batch.map((p) => p.catch(() => null)));
  out.push(...rs.filter(Boolean));
}
out.sort((a, b) => b.stars - a.stars);
for (const r of out) console.log(`${String(r.stars).padStart(7)} | ${r.pushed} | f=${String(r.forks).padStart(6)} | ${r.full}`);
