// wrapper.c - 生成 config.yml 然后 execve nezha-agent
// 编译: gcc -pie -fPIE -o wrapper wrapper.c -static
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>

int main() {
    char *server = getenv("NZ_SERVER");
    if (!server || !*server) server = "nz.zxydk1715.dpdns.org:443";
    char *tls = getenv("NZ_TLS");
    if (!tls || !*tls) tls = "true";
    char *secret = getenv("NZ_CLIENT_SECRET");
    if (!secret) secret = "";
    char *debug = getenv("NZ_DEBUG");
    if (!debug || !*debug) debug = "false";

    const char *config_path = "/rootfs/app/config.yml";
    const char *agent_path = "/rootfs/app/nezha-agent";

    FILE *f = fopen(config_path, "w");
    if (!f) {
        fprintf(stderr, "[wrapper] fopen failed\n");
        return 1;
    }
    fprintf(f, "server: %s\n", server);
    fprintf(f, "client_secret: %s\n", secret);
    fprintf(f, "tls: %s\n", tls);
    fprintf(f, "disable_auto_update: true\n");
    fprintf(f, "disable_force_update: true\n");
    fprintf(f, "disable_command_execute: false\n");
    fprintf(f, "skip_connection_count: false\n");
    fprintf(f, "debug: %s\n", debug);
    fprintf(f, "disable_send_query: false\n");
    fprintf(f, "gpu: false\n");
    fprintf(f, "report_delay: 3\n");
    fclose(f);
    printf("[wrapper] config.yml generated\n");

    char *args[] = {(char*)agent_path, "-c", (char*)config_path, NULL};
    char *envp[] = {NULL};

    // 用 syscall(SYS_execve) 避免 glibc execve 可能依赖 vDSO
    long ret = syscall(SYS_execve, agent_path, args, __environ);
    if (ret < 0) {
        perror("[wrapper] execve");
        return 1;
    }
    return 0;
}
