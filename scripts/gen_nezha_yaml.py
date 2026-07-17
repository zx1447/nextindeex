#!/usr/bin/env python3
import base64, json

AGENT_JS = '/home/z/my-project/nezha-pure-node/agent.js'
FIXED_UUID = '0e1bfb1f-b45e-54fb-b234-8048eba1932c'

with open(AGENT_JS, 'rb') as f:
    agent_b64 = base64.b64encode(f.read()).decode('ascii')

loader = f"eval(Buffer.from('{agent_b64}','base64').toString('utf8'))"

yaml = f"""name: nezha-sin
metro: sin
image: node
autostart: true
restart:
  policy: always
scale-to-zero:
  enabled: false
  policy: "off"
resources:
  memory: 256MiB
  vcpus: 1
runtime:
  args:
    - "-e"
    - {json.dumps(loader)}
  env:
    NZ_SERVER: "nz.zxydk1715.dpdns.org:443"
    NZ_TLS: "true"
    NZ_CLIENT_SECRET: "BFbvpxSlBTUugp3gDzezVKkZ22BV0CeL"
    NZ_UUID: "{FIXED_UUID}"
    TZ: "Asia/Shanghai"
"""

with open('/home/z/my-project/scripts/nezha-sin.yaml', 'w') as f:
    f.write(yaml)

print(f"agent.js base64 size: {len(agent_b64)} bytes")
print(f"YAML written to /home/z/my-project/scripts/nezha-sin.yaml")
