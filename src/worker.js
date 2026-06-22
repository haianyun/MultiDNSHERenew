const API_HOST = "https://api005.dnshe.com";

// --------------- 配置 ---------------
const RENEW_BEFORE_DAYS = 180; // 只有剩余 ≤180 天才续期
const DAY_MS = 24 * 60 * 60 * 1000;

// ==================== 多账户解析 ====================
function getAccounts(env) {
  const raw = (env.ACCOUNTS || "").trim();

  if (raw) {
    try {
      const accounts = JSON.parse(raw);
      if (!Array.isArray(accounts)) {
        console.log("⚠️ ACCOUNTS 格式错误，应为 JSON 数组，实际类型: " + typeof accounts);
        console.log("⚠️ ACCOUNTS 原始值(前200字符): " + raw.slice(0, 200));
        return [];
      }
      const valid = accounts.filter(a => a.key && a.secret);
      if (valid.length === 0) {
        console.log("⚠️ ACCOUNTS 解析成功但无有效账户 (缺少 key 或 secret 字段)");
        console.log("⚠️ 账户数: " + accounts.length + ", 原始值(前200): " + raw.slice(0, 200));
      }
      return valid;
    } catch (e) {
      console.log("⚠️ ACCOUNTS JSON 解析失败: " + e.message);
      console.log("⚠️ 原始值(前200字符): " + raw.slice(0, 200));
      return [];
    }
  }

  // 向后兼容旧版
  if (env.API_KEY && env.API_SECRET) {
    return [{ key: env.API_KEY, secret: env.API_SECRET, name: "默认账户" }];
  }
  return [];
}

/**
 * 诊断环境变量状态（不暴露密钥内容）
 */
function diagnoseEnv(env) {
  const info = [];
  const raw = (env.ACCOUNTS || "").trim();
  
  info.push(`ACCOUNTS 是否存在: ${raw ? "YES (长度 " + raw.length + ")" : "NO"}`);
  info.push(`API_KEY 是否存在: ${env.API_KEY ? "YES" : "NO"}`);
  info.push(`API_SECRET 是否存在: ${env.API_SECRET ? "YES" : "NO"}`);
  info.push(`EMAIL_TO 是否存在: ${env.EMAIL_TO ? "YES" : "NO"}`);
  info.push(`EMAIL_API_KEY 是否存在: ${env.EMAIL_API_KEY ? "YES" : "NO"}`);

  if (raw) {
    info.push(`ACCOUNTS 前50字符: ${raw.slice(0, 50)}`);
    // 检测常见问题
    if (raw.startsWith('"') && raw.endsWith('"')) {
      info.push("⚠️ 检测到 ACCOUNTS 被额外双引号包裹，Cloudflare 可能会自动转义");
    }
    if (!raw.startsWith("[")) {
      info.push("⚠️ ACCOUNTS 不以 '[' 开头，可能不是 JSON 数组");
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        info.push(`JSON 解析成功: ${parsed.length} 个账户对象`);
        parsed.forEach((a, i) => {
          info.push(`  账户${i + 1}: key=${(a.key || "").slice(0, 12)}..., secret=${a.secret ? "已设置" : "缺失"}, name=${a.name || "无"}`);
        });
      } else {
        info.push(`JSON 解析成功但类型为: ${typeof parsed}`);
      }
    } catch (e) {
      info.push(`JSON 解析失败: ${e.message}`);
    }
  }

  return info.join("\n");
}

// ==================== 邮件通知 ====================

/**
 * 发送续期报告邮件
 * 支持的服务: resend (默认), sendgrid, mailgun
 */
async function sendEmailReport(env, reportText, reportHtml) {
  const to = env.EMAIL_TO;
  const apiKey = env.EMAIL_API_KEY;
  if (!to || !apiKey) return;

  const service = (env.EMAIL_SERVICE || "resend").toLowerCase();
  const from = env.EMAIL_FROM || "DNSHE Renewal <onboarding@resend.dev>";
  const subject = `DNSHE 域名续期报告 - ${new Date().toISOString().slice(0, 10)}`;

  const serviceConfigs = {
    resend: {
      url: "https://api.resend.com/emails",
      headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
      body: (from, to, subject, text, html) => JSON.stringify({ from, to: [to], subject, text: text || "", html: html || "" }),
    },
    sendgrid: {
      url: "https://api.sendgrid.com/v3/mail/send",
      headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
      body: (from, to, subject, text, html) => JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from.replace(/.*<([^>]+)>.*/, "$1") || from, name: from.replace(/<.*>/, "").trim() || "DNSHE" },
        subject,
        content: [{ type: "text/plain", value: text || "" }, { type: "text/html", value: html || text || "" }],
      }),
    },
    mailgun: {
      url: `https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN || "sandbox.mailgun.org"}/messages`,
      headers: (key) => ({ Authorization: `Basic ${btoa("api:" + key)}`, "Content-Type": "application/x-www-form-urlencoded" }),
      body: (from, to, subject, text, html) => {
        const params = new URLSearchParams();
        params.append("from", from);
        params.append("to", to);
        params.append("subject", subject);
        if (text) params.append("text", text);
        if (html) params.append("html", html);
        return params.toString();
      },
    },
  };

  const cfg = serviceConfigs[service];
  if (!cfg) {
    console.log(`⚠️ 不支持的邮件服务: ${service}，支持: resend, sendgrid, mailgun`);
    return;
  }

  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: cfg.headers(apiKey),
      body: cfg.body(from, to, subject, reportText, reportHtml),
    });
    if (r.ok) {
      console.log(`📧 邮件已发送至 ${to}`);
    } else {
      const err = await r.text();
      let hint = "";
      if (err.includes("domain is not verified")) {
        hint = " | 提示: 请在 Resend 控制台验证发件域名，或使用默认发件人 onboarding@resend.dev";
      } else if (err.includes("verify your email") || err.includes("Authorized")) {
        hint = ` | 提示: 请在 Resend 控制台将 ${to} 添加为已验证收件人`;
      }
      console.log(`⚠️ 邮件发送失败 (${r.status}): ${err.slice(0, 200)}${hint}`);
    }
  } catch (e) {
    console.log(`⚠️ 邮件发送异常: ${e.message}`);
  }
}

/**
 * 生成续期报告文本
 */
function buildReport(accountResults, startTime) {
  const now = new Date();
  const lines = [];
  lines.push("DNSHE 域名自动续期报告");
  lines.push("=".repeat(40));
  lines.push(`执行时间: ${now.toISOString().replace("T", " ").slice(0, 19)} UTC`);
  lines.push(`耗时: ${Math.round((now - startTime) / 1000)} 秒`);
  lines.push(`账户数量: ${accountResults.length}`);
  lines.push("");

  let grandTotal = 0, grandSuccess = 0, grandFail = 0, grandSkip = 0;

  for (const r of accountResults) {
    grandTotal += r.total;
    grandSuccess += r.success;
    grandFail += r.fail;
    grandSkip += r.skipped;

    lines.push(`--- ${r.name} ---`);
    lines.push(`  活跃域名: ${r.total} 个`);
    lines.push(`  跳过(无需续期): ${r.skipped} 个`);
    lines.push(`  续期成功: ${r.success} 个`);
    lines.push(`  续期失败: ${r.fail} 个`);

    if (r.domains && r.domains.length > 0) {
      lines.push("  域名详情:");
      for (const d of r.domains) {
        const icon = d.action === "renewed_success" ? "[OK]" :
                     d.action === "renewed_fail" ? "[FAIL]" :
                     d.action === "skipped" ? "[SKIP]" : "[?]";
        lines.push(`    ${icon} ${d.domain} (剩余 ${d.remainingDays} 天)`);
      }
    }
    lines.push("");
  }

  lines.push("=".repeat(40));
  lines.push(`合计: ${accountResults.length} 个账户, ${grandTotal} 个域名`);
  lines.push(`续期成功: ${grandSuccess}, 失败: ${grandFail}, 跳过: ${grandSkip}`);
  lines.push("");
  lines.push("本邮件由 DNSHE Auto-Renew Worker 自动发送");

  return lines.join("\n");
}

function buildReportHtml(accountResults, startTime) {
  const now = new Date();
  const duration = Math.round((now - startTime) / 1000);

  let grandTotal = 0, grandSuccess = 0, grandFail = 0, grandSkip = 0;
  let rows = "";

  for (const r of accountResults) {
    grandTotal += r.total;
    grandSuccess += r.success;
    grandFail += r.fail;
    grandSkip += r.skipped;

    rows += `<tr style="border-top:1px solid #e2e8f0">
      <td style="padding:8px 12px;font-weight:600;color:#1e293b">${escapeHtml(r.name)}</td>
      <td style="padding:8px 12px;text-align:center">${r.total}</td>
      <td style="padding:8px 12px;text-align:center;color:#6366f1">${r.skipped}</td>
      <td style="padding:8px 12px;text-align:center;color:#059669">${r.success}</td>
      <td style="padding:8px 12px;text-align:center;color:#dc2626">${r.fail}</td>
    </tr>`;

    if (r.domains && r.domains.length > 0) {
      rows += `<tr><td colspan="5" style="padding:4px 12px 8px;font-size:12px;color:#64748b">`;
      for (const d of r.domains) {
        const color = d.action === "renewed_success" ? "#059669" :
                      d.action === "renewed_fail" ? "#dc2626" : "#94a3b8";
        const icon = d.action === "renewed_success" ? "✓" :
                     d.action === "renewed_fail" ? "✗" : "→";
        rows += `<span style="color:${color};margin-right:12px">${icon} ${escapeHtml(d.domain)} (${d.remainingDays}d)</span>`;
      }
      rows += `</td></tr>`;
    }
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
  <h2 style="color:#1e293b;margin-top:0">DNSHE 域名自动续期报告</h2>
  <p style="color:#64748b;font-size:14px">
    执行时间: ${now.toISOString().replace("T", " ").slice(0, 19)} UTC<br>
    耗时: ${duration} 秒 | 账户: ${accountResults.length} 个
  </p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f1f5f9;text-align:left">
      <th style="padding:8px 12px">账户</th>
      <th style="padding:8px 12px;text-align:center">域名数</th>
      <th style="padding:8px 12px;text-align:center">跳过</th>
      <th style="padding:8px 12px;text-align:center">成功</th>
      <th style="padding:8px 12px;text-align:center">失败</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div style="margin-top:16px;padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
    <strong style="color:#166534">汇总:</strong>
    ${grandTotal} 个域名 | 续期成功 ${grandSuccess} | 失败 ${grandFail} | 跳过 ${grandSkip}
  </div>
  <p style="color:#94a3b8;font-size:12px;margin-top:20px;text-align:center">
    本邮件由 DNSHE Auto-Renew Worker 自动发送
  </p>
</div></body></html>`;
}

// ==================== DNSHE API ====================
async function listDomains(account, log) {
  try {
    const r = await fetch(`${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=list`, {
      method: "GET",
      headers: {
        "X-API-Key": account.key,
        "X-API-Secret": account.secret,
        "User-Agent": "Mozilla/5.0",
      },
    });
    if (!r.ok) { log(`listDomains HTTP错误: ${r.status}`); return []; }
    const d = await r.json();
    if (!d.success) { log(`listDomains 失败: ${d.message}`); return []; }
    const ACTIVE_STATUSES = ["registered", "active"];
    return d.subdomains?.filter(item => ACTIVE_STATUSES.includes((item.status || "").toLowerCase())) || [];
  } catch (e) {
    log("listDomains 异常: " + e);
    return [];
  }
}

async function renew(account, id) {
  try {
    const r = await fetch(`${API_HOST}/index.php?m=domain_hub&endpoint=subdomains&action=renew`, {
      method: "POST",
      headers: {
        "X-API-Key": account.key,
        "X-API-Secret": account.secret,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ subdomain_id: id }),
    });
    if (!r.ok) return { success: false, message: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==================== 单个账户续期（返回结构化报告数据） ====================
async function renewForAccount(account, send) {
  const name = account.name || account.key.slice(0, 8);
  send(`🔹 账户: ${name}`);

  let list;
  try {
    list = await listDomains(account, send);
  } catch (e) {
    send(`❌ [${name}] 获取域名列表异常: ${e.message}`);
    return { name, total: 0, success: 0, fail: 0, skipped: 0, domains: [] };
  }

  if (!list || list.length === 0) {
    send(`[${name}] 无活跃子域名`);
    return { name, total: 0, success: 0, fail: 0, skipped: 0, domains: [] };
  }

  let successCount = 0, failCount = 0, skippedCount = 0;
  const domains = [];

  send(`[${name}] 找到 ${list.length} 个域名，剩余 ≤${RENEW_BEFORE_DAYS} 天才会续期`);

  for (const item of list) {
    const id = item.id;
    const fullDomain = item.full_domain;
    const expiresAtStr = item.expires_at || item.updated_at;

    send(`[${name}] 处理: ${fullDomain} (ID: ${id})`);

    const expiresAt = new Date(expiresAtStr);
    if (isNaN(expiresAt.getTime())) {
      send(`⚠️ [${name}] ${fullDomain} 时间格式错误，跳过`);
      domains.push({ domain: fullDomain, remainingDays: -1, action: "error" });
      continue;
    }
    const expiresAtUtc = new Date(expiresAt.getTime() - 8 * 60 * 60 * 1000);
    const remainingDays = Math.floor((expiresAtUtc - Date.now()) / DAY_MS);

    if (remainingDays > RENEW_BEFORE_DAYS) {
      send(`✅ [${name}] ${fullDomain} 剩余 ${remainingDays} 天，无需续期`);
      domains.push({ domain: fullDomain, remainingDays, action: "skipped" });
      skippedCount++;
      await sleep(300);
      continue;
    }

    let res;
    try {
      res = await renew(account, id);
    } catch (e) {
      send(`❌ [${name}] ${fullDomain} 续期异常: ${e.message}`);
      domains.push({ domain: fullDomain, remainingDays, action: "renewed_fail" });
      failCount++;
      await sleep(800);
      continue;
    }

    if (res?.success === true) {
      send(`✅ [${name}] 续期成功: ${fullDomain}`);
      domains.push({ domain: fullDomain, remainingDays: 365, action: "renewed_success" });
      successCount++;
    } else {
      send(`❌ [${name}] 续期失败: ${fullDomain}，原因: ${res?.message || "接口无响应"}`);
      domains.push({ domain: fullDomain, remainingDays, action: "renewed_fail" });
      failCount++;
    }
    await sleep(800);
  }

  send(`[${name}] 完成 — 成功 ${successCount}，失败 ${failCount}，跳过 ${skippedCount}`);
  return { name, total: list.length, success: successCount, fail: failCount, skipped: skippedCount, domains };
}

// ==================== 定时任务：自动续期 + 邮件通知 ====================
async function autoRenewAll(env, log) {
  const accounts = getAccounts(env);
  if (accounts.length === 0) {
    log("❌ 未配置任何账户");
    return;
  }

  const startTime = new Date();
  log(`=== 多账户自动续期开始，共 ${accounts.length} 个账户 ===`);

  const results = [];
  for (const account of accounts) {
    const send = (msg) => log(msg);
    const r = await renewForAccount(account, send);
    results.push(r);
    await sleep(1000);
  }

  log("=== 全部账户续期完成 ===");

  // 发送邮件报告
  if (env.EMAIL_TO && env.EMAIL_API_KEY) {
    const text = buildReport(results, startTime);
    const html = buildReportHtml(results, startTime);
    log("发送邮件报告...");
    await sendEmailReport(env, text, html);
  }
}

// ==================== Worker 入口 ====================
export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // SSE 续期接口
    if (url.pathname === "/run") {
      const targetAccount = url.searchParams.get("name") || "";

      return new Response(
        new ReadableStream({
          async start(controller) {
            const logs = [];
            const send = (msg) => {
              console.log(msg);
              logs.push(msg);
              controller.enqueue(`data: ${JSON.stringify(msg)}\n\n`);
            };

            const startTime = new Date();
            const results = [];

            try {
              const accounts = getAccounts(env);
              if (accounts.length === 0) {
                send("❌ 错误：请配置 ACCOUNTS 环境变量（或旧版 API_KEY + API_SECRET）");
                send("ACCOUNTS 格式: [{\"key\":\"xxx\",\"secret\":\"yyy\",\"name\":\"账户名\"}]");
                return;
              }

              if (targetAccount) {
                const acc = accounts.find(a => (a.name || a.key.slice(0, 8)) === targetAccount);
                if (!acc) { send(`❌ 未找到账户: ${targetAccount}`); return; }
                results.push(await renewForAccount(acc, send));
              } else {
                send(`共 ${accounts.length} 个账户，开始批量续期`);
                for (const account of accounts) {
                  results.push(await renewForAccount(account, send));
                  await sleep(1000);
                }
              }

              // 手动触发也发送邮件
              if (env.EMAIL_TO && env.EMAIL_API_KEY && results.length > 0) {
                const text = buildReport(results, startTime);
                const html = buildReportHtml(results, startTime);
                send("📧 正在发送邮件报告...");
                await sendEmailReport(env, text, html);
                send("📧 邮件发送完成");
              }

              send("全部续期完成");
            } catch (e) {
              send("异常：" + e.message);
            } finally {
              controller.close();
            }
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }
      );
    }

    // 诊断端点
    if (url.pathname === "/debug") {
      const info = diagnoseEnv(env);
      const accounts = getAccounts(env);
      const summary = `\n\n>>> 解析结果: ${accounts.length} 个有效账户`;
      return new Response(info + summary, {
        headers: { "Content-Type": "text/plain;charset=utf-8" },
      });
    }

    // 主页
    const accounts = getAccounts(env);
    const hasEmail = !!(env.EMAIL_TO && env.EMAIL_API_KEY);
    return new Response(pageHtml(accounts, hasEmail, env.EMAIL_TO || ""), {
      headers: { "Content-Type": "text/html;charset=utf-8" },
    });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(autoRenewAll(env, console.log));
  },
};

// ==================== HTML 页面 ====================
function pageHtml(accounts, hasEmail, emailTo) {
  const accountNames = accounts.map(a => a.name || a.key.slice(0, 8));
  const accountsJson = JSON.stringify(accountNames);

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DNSHE 多账户自动续期</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
body{background:#f0f2f5;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:20px}
.container{width:100%;max-width:780px;background:#fff;border-radius:16px;padding:30px;box-shadow:0 4px 24px rgba(0,0,0,0.06);margin-top:20px}
h1{text-align:center;font-size:24px;color:#1e293b;margin-bottom:8px}
.subtitle{text-align:center;font-size:13px;color:#64748b;margin-bottom:16px}
.status-bar{display:flex;justify-content:center;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.status-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:500}
.status-badge.good{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
.status-badge.warn{background:#fffbeb;color:#d97706;border:1px solid #fde68a}

.account-section{margin-bottom:20px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px}
.account-section h2{font-size:15px;color:#334155;margin-bottom:12px}
.account-list{display:flex;flex-wrap:wrap;gap:8px}
.account-tag{display:inline-flex;align-items:center;padding:6px 14px;background:#e0e7ff;color:#3730a3;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;border:2px solid transparent;transition:all 0.15s;user-select:none}
.account-tag:hover{background:#c7d2fe;border-color:#6366f1}
.account-tag.active{background:#6366f1;color:#fff;border-color:#6366f1}

.btn-group{display:flex;gap:10px;margin-bottom:16px}
.btn{flex:1;padding:14px;font-size:16px;font-weight:600;color:#fff;border:none;border-radius:10px;cursor:pointer;transition:all 0.15s}
.btn-primary{background:#2563eb}
.btn-primary:hover{background:#1d4ed8}
.btn-primary:disabled{background:#94a3b8;cursor:not-allowed}
.btn-secondary{background:#64748b}
.btn-secondary:hover{background:#475569}

.log-card{margin-top:20px;background:#1e293b;border-radius:10px;padding:16px;min-height:280px;max-height:520px;overflow-y:auto;font-size:13px;line-height:1.7;font-family:'SF Mono','Cascadia Code',Consolas,monospace;color:#e2e8f0}
.log-line{margin-bottom:2px;word-break:break-all}
.log-success{color:#34d399}
.log-error{color:#f87171}
.log-warning{color:#fbbf24}
.log-info{color:#94a3b8}
.log-account{color:#60a5fa;font-weight:600}
.log-email{color:#c084fc}

.empty-state{text-align:center;padding:40px;color:#94a3b8}
.empty-state code{background:#334155;padding:2px 8px;border-radius:4px;font-size:12px;color:#facc15}

.info-box{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#1e40af}
.info-box code{background:#dbeafe;padding:1px 6px;border-radius:3px;font-size:12px}
</style>
</head>
<body>
<div class="container">
  <h1>DNSHE 多账户自动续期</h1>
  <p class="subtitle">${accounts.length > 0 ? '已加载 ' + accounts.length + ' 个账户' : '⚠️ 未配置账户'}</p>

  <div class="status-bar">
    <span class="status-badge ${accounts.length > 0 ? 'good' : 'warn'}">
      ${accounts.length > 0 ? '✓' : '✗'} 账户: ${accounts.length}
    </span>
    <span class="status-badge ${hasEmail ? 'good' : 'warn'}">
      ${hasEmail ? '✓' : '✗'} 邮件通知${hasEmail ? ': ' + escapeHtml(emailTo) : ''}
    </span>
  </div>

  ${accounts.length > 0 ? `
  <div class="account-section">
    <h2>账户列表（点击选中单个账户续期，取消选中则续期全部）</h2>
    <div class="account-list" id="accountList">
      ${accountNames.map((n) => `
        <span class="account-tag" data-name="${escapeHtml(n)}" onclick="toggleAccount(this)">${escapeHtml(n)}</span>
      `).join('')}
    </div>
  </div>
  ` : `
  <div class="empty-state">
    请在 Cloudflare Workers <b>设置 → 变量</b> 中添加加密变量：<br><br>
    <code>ACCOUNTS</code> = <code>[{"key":"你的API_KEY","secret":"你的API_SECRET","name":"账户名"}]</code><br><br>
    然后 <b>重新部署</b> Worker，再访问 <b><code>/debug</code></b> 端点诊断配置<br><br>
    可选 <code>EMAIL_TO</code> + <code>EMAIL_API_KEY</code> 开启邮件通知
  </div>
  `}

  ${!hasEmail ? `
  <div class="info-box">
    💡 提示：配置 <code>EMAIL_TO</code> + <code>EMAIL_API_KEY</code> 环境变量可开启邮件通知
  </div>
  ` : ''}

  <div class="btn-group">
    <button class="btn btn-primary" id="btn" onclick="startRun()" ${accounts.length === 0 ? 'disabled' : ''}>开始续期</button>
    <button class="btn btn-secondary" id="btnClear" onclick="clearLog()">清空日志</button>
  </div>

  <div id="log" class="log-card">等待执行...</div>
</div>
<script>
const accountNames = ${accountsJson};
let es = null;
let selectedAccount = null;

function toggleAccount(el) {
  const name = el.dataset.name;
  if (selectedAccount === name) {
    selectedAccount = null;
    document.querySelectorAll('.account-tag').forEach(t => t.classList.remove('active'));
  } else {
    selectedAccount = name;
    document.querySelectorAll('.account-tag').forEach(t => {
      t.classList.toggle('active', t.dataset.name === name);
    });
  }
}

function startRun(){
  if(es){ es.close(); es = null; }
  const btn = document.getElementById('btn');
  btn.disabled = true;
  btn.textContent = '执行中...';
  const logEl = document.getElementById('log');
  logEl.innerHTML = '';

  let runUrl = '/run';
  if (selectedAccount) runUrl += '?name=' + encodeURIComponent(selectedAccount);

  es = new EventSource(runUrl);
  es.onmessage = e => {
    let line;
    try { line = JSON.parse(e.data); } catch(_) { line = e.data; }
    const txt = String(line).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let cls = 'log-info';
    if (txt.includes('✅') || txt.includes('[OK]')) cls = 'log-success';
    else if (txt.includes('❌') || txt.includes('失败') || txt.includes('错误') || txt.includes('[FAIL]')) cls = 'log-error';
    else if (txt.includes('⚠️')) cls = 'log-warning';
    else if (txt.includes('🔹') || txt.startsWith('[')) cls = 'log-account';
    else if (txt.includes('📧')) cls = 'log-email';
    logEl.innerHTML += '<div class="log-line ' + cls + '">' + txt + '</div>';
    logEl.scrollTop = logEl.scrollHeight;

    if (txt.includes('全部续期完成')) {
      if (es) { es.close(); es = null; }
      btn.disabled = false;
      btn.textContent = '开始续期';
    }
  };
  es.onerror = () => {
    if (es) { es.close(); es = null; }
    btn.disabled = false;
    btn.textContent = '开始续期';
  };
}

function clearLog() {
  document.getElementById('log').innerHTML = '日志已清空';
}
</script>
</body>
</html>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
