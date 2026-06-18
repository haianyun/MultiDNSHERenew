# -*- coding: utf-8 -*-
"""
DNSHE 多账户自动续期 -- 本地测试脚本
验证: API连通性 + 域名状态 + 续期逻辑 + 邮件通知

用法:
  python test_accounts.py           # DRY RUN (只查状态,不发邮件)
  python test_accounts.py --email   # DRY RUN + 发送测试邮件
  python test_accounts.py --renew   # 正式续期 + 发邮件

使用前请修改下方的 ACCOUNTS 和 EMAIL_* 配置
"""
import requests
import json
import time
import sys
from datetime import datetime, timezone, timedelta

API_HOST = "https://api005.dnshe.com"
RENEW_BEFORE_DAYS = 180

# ==================== 请在此填入你的配置 ====================
ACCOUNTS = [
    {"key": "YOUR_DNSHE_API_KEY_1",
     "secret": "YOUR_DNSHE_API_SECRET_1",
     "name": "账户一"},
    {"key": "YOUR_DNSHE_API_KEY_2",
     "secret": "YOUR_DNSHE_API_SECRET_2",
     "name": "账户二"},
]

# 邮件配置（可选，使用 Resend 作为邮件服务）
EMAIL_TO = ""                           # 接收报告的邮箱
EMAIL_API_KEY = ""                      # Resend API Key
EMAIL_SERVICE = "resend"                # resend / sendgrid / mailgun
EMAIL_FROM = "DNSHE Renewal <onboarding@resend.dev>"
# ============================================================

def log(msg):
    print(f"  {msg}", flush=True)

def get_headers(account):
    return {
        "X-API-Key": account["key"],
        "X-API-Secret": account["secret"],
        "User-Agent": "Mozilla/5.0",
    }

def list_domains(account):
    try:
        r = requests.get(
            f"{API_HOST}/index.php",
            params={"m": "domain_hub", "endpoint": "subdomains", "action": "list"},
            headers=get_headers(account), timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if not data.get("success"):
            log(f"API returned failure: {data.get('message', 'unknown error')}")
            return [], data
        ACTIVE_STATUSES = {"registered", "active"}
        active = [item for item in data.get("subdomains", [])
                  if (item.get("status") or "").lower() in ACTIVE_STATUSES]
        log(f"Total: {len(data.get('subdomains', []))}, Active: {len(active)}")
        return active, data
    except requests.RequestException as e:
        log(f"Network error: {e}")
        return [], None
    except json.JSONDecodeError:
        log("Response is not JSON")
        return [], None

def renew_domain(account, subdomain_id):
    try:
        r = requests.post(
            f"{API_HOST}/index.php",
            params={"m": "domain_hub", "endpoint": "subdomains", "action": "renew"},
            headers=get_headers(account),
            json={"subdomain_id": subdomain_id}, timeout=30,
        )
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        return {"success": False, "message": str(e)}

def calc_remaining_days(expires_at_str):
    try:
        expires_at = datetime.strptime(expires_at_str, "%Y-%m-%d %H:%M:%S")
        expires_at_utc = expires_at - timedelta(hours=8)
        now = datetime.now(timezone.utc)
        return (expires_at_utc.replace(tzinfo=timezone.utc) - now).days
    except Exception:
        return -1

def send_email_report(report_text, report_html, subject_extra=""):
    if not EMAIL_TO or not EMAIL_API_KEY:
        log("[SKIP] Email not configured (set EMAIL_TO and EMAIL_API_KEY)")
        return False

    subject = f"DNSHE 域名续期报告 - {datetime.now().strftime('%Y-%m-%d')}"
    if subject_extra:
        subject += f" [{subject_extra}]"

    log(f"Sending email to: {EMAIL_TO} ...")
    try:
        r = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {EMAIL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "from": EMAIL_FROM,
                "to": [EMAIL_TO],
                "subject": subject,
                "text": report_text,
                "html": report_html,
            },
            timeout=30,
        )
        if r.ok:
            log(f"[OK] Email sent successfully to {EMAIL_TO}")
            return True
        else:
            err_text = r.text
            hint = ""
            if "domain is not verified" in err_text:
                hint = "\n     Hint: Verify your sender domain at https://resend.com/domains"
                hint += "\n     Or use default sender: onboarding@resend.dev"
            elif "verify your email" in err_text or "Authorized" in err_text:
                hint = f"\n     Hint: Add {EMAIL_TO} as authorized recipient in Resend console"
            log(f"[FAIL] Email send failed ({r.status_code}): {err_text[:300]}{hint}")
            return False
    except Exception as e:
        log(f"[FAIL] Email exception: {e}")
        return False

def build_report(results, start_time):
    now = datetime.now()
    duration = round((now - start_time).total_seconds())
    lines = [
        "DNSHE 域名自动续期报告",
        "="*40,
        f"执行时间: {now.strftime('%Y-%m-%d %H:%M:%S')} UTC",
        f"耗时: {duration} 秒",
        f"账户数量: {len(results)}",
        "",
    ]

    grand_total = grand_success = grand_fail = grand_skip = 0
    for r in results:
        grand_total += r["total"]
        grand_success += r["success"]
        grand_fail += r["fail"]
        grand_skip += r["skipped"]

        lines.append(f"--- {r['name']} ---")
        lines.append(f"  域名总数: {r['total']}")
        lines.append(f"  跳过(无需续期): {r['skipped']}")
        lines.append(f"  续期成功: {r['success']}")
        lines.append(f"  续期失败: {r['fail']}")

        for d in r.get("domains", []):
            icon = {"renewed_success":"[OK]","renewed_fail":"[FAIL]","skipped":"[SKIP]"}.get(d["action"],"[?]")
            lines.append(f"    {icon} {d['domain']} (剩余 {d['remainingDays']} 天)")
        lines.append("")

    lines.append("="*40)
    lines.append(f"合计: {len(results)} 账户, {grand_total} 个域名")
    lines.append(f"续期成功: {grand_success}, 失败: {grand_fail}, 跳过: {grand_skip}")
    lines.append("")
    lines.append("本邮件由 DNSHE Auto-Renew Worker 自动发送")
    return "\n".join(lines)

def build_report_html(results, start_time):
    now = datetime.now()
    duration = round((now - start_time).total_seconds())

    grand_total = grand_success = grand_fail = grand_skip = 0
    rows = ""

    for r in results:
        grand_total += r["total"]
        grand_success += r["success"]
        grand_fail += r["fail"]
        grand_skip += r["skipped"]

        rows += f"""<tr style="border-top:1px solid #e2e8f0">
            <td style="padding:8px 12px;font-weight:600;color:#1e293b">{r['name']}</td>
            <td style="padding:8px 12px;text-align:center">{r['total']}</td>
            <td style="padding:8px 12px;text-align:center;color:#6366f1">{r['skipped']}</td>
            <td style="padding:8px 12px;text-align:center;color:#059669">{r['success']}</td>
            <td style="padding:8px 12px;text-align:center;color:#dc2626">{r['fail']}</td>
        </tr>"""

        if r.get("domains"):
            rows += '<tr><td colspan="5" style="padding:4px 12px 8px;font-size:12px;color:#64748b">'
            for d in r["domains"]:
                color = {"renewed_success":"#059669","renewed_fail":"#dc2626"}.get(d["action"], "#94a3b8")
                icon = {"renewed_success":"v","renewed_fail":"x"}.get(d["action"], ">")
                rows += f'<span style="color:{color};margin-right:12px">{icon} {d["domain"]} ({d["remainingDays"]}d)</span>'
            rows += '</td></tr>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
<h2 style="color:#1e293b;margin-top:0">DNSHE 域名自动续期报告</h2>
<p style="color:#64748b;font-size:14px">
执行时间: {now.strftime('%Y-%m-%d %H:%M:%S')} UTC<br>
耗时: {duration} 秒 | 账户: {len(results)} 个
</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
<thead><tr style="background:#f1f5f9;text-align:left">
<th style="padding:8px 12px">账户</th>
<th style="padding:8px 12px;text-align:center">域名数</th>
<th style="padding:8px 12px;text-align:center">跳过</th>
<th style="padding:8px 12px;text-align:center">成功</th>
<th style="padding:8px 12px;text-align:center">失败</th>
</tr></thead>
<tbody>{rows}</tbody>
</table>
<div style="margin-top:16px;padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
<strong style="color:#166534">汇总:</strong>
{grand_total} 个域名 | 续期成功 {grand_success} | 失败 {grand_fail} | 跳过 {grand_skip}
</div>
<p style="color:#94a3b8;font-size:12px;margin-top:20px;text-align:center">
本邮件由 DNSHE Auto-Renew Worker 自动发送
</p>
</div></body></html>"""

def test_account(account, dry_run=True):
    name = account["name"]
    print(f"\n{'='*60}")
    print(f"[Account] {name}")
    print(f"  Key: {account['key'][:12]}...")
    print(f"{'='*60}")

    log("Fetching domain list...")
    domains, raw_data = list_domains(account)
    if not domains:
        log("[WARN] No active domains or fetch failed")
        if raw_data:
            log(f"  Raw: {json.dumps(raw_data, ensure_ascii=False, indent=2)[:300]}")
        return {"name": name, "total": 0, "success": 0, "fail": 0, "skipped": 0, "domains": []}

    need_renew = []
    no_renew = []
    domains_detail = []

    print(f"\n  Checking {len(domains)} domains renewal status...")
    print(f"  {'Domain':<28} {'ID':<10} {'Remaining':>8}  {'Expires':>20}  {'Action'}")
    print(f"  {'-'*28} {'-'*10} {'-'*8}  {'-'*20}  {'-'*10}")

    for d in domains:
        domain_id = d.get("id")
        full_domain = d.get("full_domain", "N/A")
        expires_at = d.get("expires_at", "")

        remaining = calc_remaining_days(expires_at)
        remaining_str = f"{remaining}d" if remaining >= 0 else "N/A"

        if 0 <= remaining <= RENEW_BEFORE_DAYS:
            need_renew.append(d)
            action = "NEED RENEW"
            domains_detail.append({"domain": full_domain, "remainingDays": remaining, "action": "pending"})
        elif remaining > RENEW_BEFORE_DAYS:
            no_renew.append(d)
            action = "skip"
            domains_detail.append({"domain": full_domain, "remainingDays": remaining, "action": "skipped"})
        else:
            action = "error"

        print(f"  {full_domain:<28} {str(domain_id):<10} {remaining_str:>8}  {expires_at:>20}  {action}")

    print(f"\n  Summary: Need renew={len(need_renew)}, Skip={len(no_renew)}")

    renewed = 0
    failed = 0

    if need_renew:
        action_word = "[DRY RUN] Would renew" if dry_run else "Renewing"
        print(f"\n  {action_word} {len(need_renew)} domain(s)...")

        for d in need_renew:
            domain_id = d.get("id")
            full_domain = d.get("full_domain", "N/A")

            for dd in domains_detail:
                if dd["domain"] == full_domain:
                    if dry_run:
                        dd["action"] = "skipped"
                    break

            if dry_run:
                log(f"  [DRY RUN] {full_domain} -- skipped")
                continue

            log(f"  Renewing: {full_domain}")
            result = renew_domain(account, domain_id)
            if result.get("success"):
                log(f"  [OK] Renewed: {full_domain}")
                renewed += 1
                for dd in domains_detail:
                    if dd["domain"] == full_domain:
                        dd["action"] = "renewed_success"
                        dd["remainingDays"] = 365
                        break
            else:
                log(f"  [FAIL] {full_domain}, reason: {result.get('message', 'no response')}")
                failed += 1
            time.sleep(0.8)
    else:
        print("  No domains need renewal")

    return {
        "name": name,
        "total": len(domains),
        "success": renewed,
        "fail": failed,
        "skipped": len(no_renew),
        "domains": domains_detail,
    }


if __name__ == "__main__":
    dry_run = "--renew" not in sys.argv
    send_email = "--email" in sys.argv or "--renew" in sys.argv

    print("=" * 60)
    print("  DNSHE Multi-Account Auto-Renew -- Local Test")
    print(f"  Mode: {'DRY RUN' if dry_run else 'LIVE RENEWAL'}")
    print(f"  Email: {'YES -> ' + EMAIL_TO if send_email and EMAIL_TO else 'NO'}")
    print(f"  Accounts: {len(ACCOUNTS)}")
    print(f"  Renewal threshold: <= {RENEW_BEFORE_DAYS} days remaining")
    print("=" * 60)

    if not dry_run:
        confirm = input("\n[WARNING] Will perform actual renewal! Type YES to confirm: ")
        if confirm.strip().upper() != "YES":
            print("Cancelled")
            sys.exit(0)

    start_time = datetime.now()
    results = []
    for acc in ACCOUNTS:
        r = test_account(acc, dry_run=dry_run)
        results.append(r)
        time.sleep(1)

    print("\n\n" + "=" * 60)
    print("  TEST SUMMARY")
    print("=" * 60)
    for r in results:
        print(f"\n  {r['name']}:")
        print(f"    Active domains: {r['total']}")
        print(f"    Skipped:        {r['skipped']}")
        print(f"    Renewed:        {r['success']}")
        print(f"    Failed:         {r['fail']}")

    total_domains = sum(r["total"] for r in results)
    total_renewed = sum(r["success"] for r in results)
    total_failed = sum(r["fail"] for r in results)
    total_skipped = sum(r["skipped"] for r in results)

    print(f"\n  >> Total: {len(results)} accounts, {total_domains} active domains")
    print(f"     Success: {total_renewed}, Failed: {total_failed}, Skipped: {total_skipped}")

    if send_email and EMAIL_TO:
        print("\n" + "=" * 60)
        print("  SENDING EMAIL REPORT")
        print("=" * 60)
        report_text = build_report(results, start_time)
        report_html = build_report_html(results, start_time)
        mode = "DRY RUN" if dry_run else "LIVE"
        email_ok = send_email_report(report_text, report_html, mode)
        print(f"\n  Email result: {'SUCCESS' if email_ok else 'FAILED'}")
        if email_ok:
            print(f"  Please check: {EMAIL_TO}")
    else:
        print("\n  Tip: configure EMAIL_TO + EMAIL_API_KEY and use --email to send test report")
        print("       use --renew to perform actual renewal + email")

    print()
