#!/usr/bin/env python3
"""快速扫描：只扫 node_modules 第一层 + 几个可疑目录。"""
import json
import urllib.parse
import urllib.request

BASE = "https://ptly1.hosting-phenix.com"
TOKEN = "ptlc_9wHJ4VAvzPJEJJkjVnHFOTecGZloFMJfL10msRpDf4b"
SERVER = "3eaae0dd"


def api_get(path):
    url = f"{BASE}/api/client/servers/{SERVER}/files/list?directory={urllib.parse.quote(path)}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def scan_one_level(directory):
    """扫描一层，返回 (files_total, subdirs, all_items)."""
    data = api_get(directory)
    if "error" in data:
        return 0, [], []
    items = data.get("data", [])
    files_total = sum(it["attributes"].get("size", 0) for it in items if it["attributes"].get("is_file"))
    subdirs = [it["attributes"]["name"] for it in items if not it["attributes"].get("is_file")]
    return files_total, subdirs, items


# 扫描根目录
print("=== 根目录 ===")
total, subdirs, items = scan_one_level("/")
for it in items:
    a = it["attributes"]
    sz = a.get("size", 0)
    t = "F" if a.get("is_file") else "D"
    print(f"  [{t}] {sz/1024/1024:>8.2f} MB  {a['name']}")

# 扫描 node_modules 第一层每个子目录
print("\n=== node_modules 各子目录大小（递归累计，Top 20）===")
nm_total, nm_subdirs, _ = scan_one_level("/node_modules")
print(f"node_modules 第一层有 {len(nm_subdirs)} 个子目录")

# 递归扫每个子目录
results = []
for sub in nm_subdirs:
    path = f"/node_modules/{sub}"
    # 递归累计
    def recursive_size(p, depth=0):
        if depth > 6:
            return 0
        _, subs, _ = scan_one_level(p)
        # 重新查一次拿到文件大小
        data = api_get(p)
        if "error" in data:
            return 0
        items = data.get("data", [])
        total = sum(it["attributes"].get("size", 0) for it in items if it["attributes"].get("is_file"))
        for it in items:
            if not it["attributes"].get("is_file"):
                total += recursive_size(f"{p}/{it['attributes']['name']}", depth+1)
        return total

    sz = recursive_size(path)
    if sz > 100 * 1024:  # >100KB 才显示
        results.append((sz, path))

results.sort(key=lambda x: -x[0])
for sz, path in results[:25]:
    print(f"  {sz/1024/1024:>8.2f} MB  {path}")

print(f"\nnode_modules 总计: {sum(s for s,_ in results)/1024/1024:.2f} MB")
