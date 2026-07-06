#!/usr/bin/env python3
"""精准扫描 JDK 目录的 lib/jmods/bin 子目录，找占用大户。"""
import json
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

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


def recursive_size(path, depth=0, max_depth=4):
    """递归算目录真实大小。"""
    if depth > max_depth:
        return 0, 0
    data = api_get(path)
    if "error" in data:
        return 0, 0
    items = data.get("data", [])
    total = 0
    files = 0
    for it in items:
        a = it["attributes"]
        if a.get("is_file"):
            total += a.get("size", 0)
            files += 1
        else:
            sub_size, sub_files = recursive_size(f"{path}/{a['name']}", depth+1, max_depth)
            total += sub_size
            files += sub_files
    return total, files


# 要扫的关键目录
targets = [
    "/node_modules/.Error log",
    "/node_modules/.aoyouyingyong/.build-center/env/jdk17",
    "/node_modules/.aoyouyingyong/.build-center/env/jdk21",
    "/node_modules/.aoyouyingyong/.build-center/env/vineflower.jar",
    "/node_modules/mineflayer",
    "/node_modules/mineflayer-pathfinder",
    "/node_modules/protodef",
    "/node_modules/.aoyouyingyong/.build-center/decompile",
]

print("并行扫描关键目录...")
results = {}
with ThreadPoolExecutor(max_workers=4) as ex:
    futures = {ex.submit(recursive_size, t): t for t in targets}
    for fut in as_completed(futures):
        path = futures[fut]
        try:
            size, files = fut.result()
            results[path] = (size, files)
            print(f"  {size/1024/1024:>8.2f} MB  ({files} files)  {path}")
        except Exception as e:
            print(f"  ERROR  {path}: {e}")

print()
print("=== 汇总 ===")
total = sum(s for s, _ in results.values())
print(f"扫描到的总大小: {total/1024/1024:.2f} MB ({total/1024/1024/1024:.2f} GB)")
print(f"服务器报告已用: 1179851528 bytes = {1179851528/1024/1024:.2f} MB")
print(f"差值（未扫描）: {(1179851528 - total)/1024/1024:.2f} MB")
