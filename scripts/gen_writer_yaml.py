#!/usr/bin/env python3
# 生成临时实例的 YAML：用 env 传 base64 agent.js，写入 volume
import base64, json

AGENT_JS = '/home/z/my-project/nezha-pure-node/agent.js'
FIXED_UUID = 'c592af8b-b49f-e6cf-8f68-f3c57faec830'

with open(AGENT_JS, 'rb') as f:
    agent_b64 = base64.b64encode(f.read()).decode('ascii')

# 内联写入脚本（< 500 字节）
writer = "require('fs').writeFileSync('/data/agent.js',Buffer.from(process.env.AGENT_B64,'base64'));console.log('written',require('fs').statSync('/data/agent.js').size);"

yaml = f"""name: nezha-writer
metro: sin
image: node
autostart: true
restart:
  policy: never
scale-to-zero:
  enabled: false
  policy: "off"
resources:
  memory: 512MiB
  vcpus: 1
volumes:
  - name: nezha-data
    at: /data
runtime:
  args:
    - "-e"
    - {json.dumps(writer)}
  env:
    AGENT_B64: {json.dumps(agent_b64)}
"""

with open('/home/z/my-project/scripts/nezha-writer.yaml', 'w') as f:
    f.write(yaml)

print(f"agent.js base64 size: {len(agent_b64)} bytes")
print(f"YAML written")
