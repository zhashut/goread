import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """npm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )
                
                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")

        // 在 CI/无头环境下，tauri android-studio-script 命令会尝试读取
        // /tmp/com.tauri-app.xxx-server-addr 文件（IPC 服务器地址）
        // 该文件仅在有开发服务器运行时存在，CI 环境中不存在会导致 panic
        // 因此在调用命令前预先创建此文件作为占位修复方案
        // 参考：tauri-cli mobile/mod.rs 中对 addr 文件的读取逻辑
        val identifier = project.findProperty("tauriAndroidPackage") as? String ?: "com.tauri-app.goread"
        val tempDir = System.getProperty("java.io.tmpdir")
        val addrFile = java.io.File(tempDir, "$identifier-server-addr")
        try {
            // 如果文件不存在，则创建一个空文件，避免 tauri-cli 因 No such file 而 panic
            if (!addrFile.exists()) {
                addrFile.createNewFile()
                project.logger.info("Created placeholder addr file: ${addrFile.absolutePath}")
            }
        } catch (e: Exception) {
            // 创建占位文件失败不阻塞构建，仅记录日志
            project.logger.warn("Failed to create placeholder addr file (non-blocking): ${e.message}")
        }

        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}