// wrapper.go - 生成 config.yml 然后 exec nezha-agent 替换进程
package main

import (
	"fmt"
	"os"
	"syscall"
)

func main() {
	server := os.Getenv("NZ_SERVER")
	if server == "" {
		server = "nz.zxydk1715.dpdns.org:443"
	}
	tls := os.Getenv("NZ_TLS")
	if tls == "" {
		tls = "true"
	}
	secret := os.Getenv("NZ_CLIENT_SECRET")
	debug := os.Getenv("NZ_DEBUG")
	if debug == "" {
		debug = "false"
	}

	configPath := "/rootfs/app/config.yml"
	agentPath := "/rootfs/app/nezha-agent"

	config := fmt.Sprintf(`server: %s
client_secret: %s
tls: %s
disable_auto_update: true
disable_force_update: true
disable_command_execute: false
skip_connection_count: false
debug: %s
disable_send_query: false
gpu: false
report_delay: 3
`, server, secret, tls, debug)

	if err := os.WriteFile(configPath, []byte(config), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "[wrapper] write config failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("[wrapper] config.yml generated")

	// exec nezha-agent, replacing this process
	args := []string{agentPath, "-c", configPath}
	if err := syscall.Exec(agentPath, args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[wrapper] exec failed: %v\n", err)
		os.Exit(1)
	}
}
