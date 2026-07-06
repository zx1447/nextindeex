#!/usr/bin/env python3
"""递归扫描 Pterodactyl 服务器磁盘占用，找最大的文件/目录。"""
import json
import urllib.parse
import urllib.request
import sys
from collections import defaultdict

BASE = "https://ptly1.hosting-phenix.com"
TOKEN = "ptlc_9wHJ4VAvzPJEJJkjVnHFOTecGZloFMJfL10msRpDf4b"
SERVER = "3eaae0dd"

# 全局统计
dir_sizes = defaultdict(int)  # 路径 -> 累计字节数（仅文件，目录不递归加 inode）
file_list = []  # (size, path)
visited = set()
MAX_DEPTH = 4  # 避免无限递归


def api_get(path):
    """调用 Pterodactyl files/list API。"""
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


def scan(directory, depth=0):
    if depth > MAX_DEPTH:
        return
    if directory in visited:
        return
    visited.add(directory)

    data = api_get(directory)
    if "error" in data:
        return

    items = data.get("data", [])
    for item in items:
        a = item["attributes"]
        name = a["name"]
        size = a.get("size", 0)
        is_file = a.get("is_file", True)
        full_path = f"{directory}/{name}".replace("//", "/")

        if is_file:
            dir_sizes[directory] += size
            file_list.append((size, full_path))
        else:
            # 目录，递归
            scan(full_path, depth + 1)
            # 子目录的大小累加到父目录
            dir_sizes[directory] += dir_sizes.get(full_path, 0)


if __name__ == "__main__":
    print("扫描中，可能需要 1-2 分钟...")
    scan("/")

    # Top 20 大目录
    print("\n=== Top 20 大目录（按累计文件大小）===")
    sorted_dirs = sorted(dir_sizes.items(), key=lambda x: -x[1])
    for path, size in sorted_dirs[:20]:
        print(f"  {size/1024/1024:>10.2f} MB  {path}")

    # Top 20 大文件
    print("\n=== Top 20 大文件 ===")
    sorted_files = sorted(file_list, key=lambda x: -x[0])
    for size, path in sorted_files[:20]:
        print(f"  {size/1024/1024:>10.2f} MB  {path}")

    # 总计
    total = sum(s for s, _ in file_list)
    print(f"\n=== 扫描到的文件总大小: {total/1024/1024:.2f} MB ({total/1024/1024/1024:.2f} GB) ===")
    print(f"扫描目录数: {len(visited)}, 文件数: {len(file_list)}")
