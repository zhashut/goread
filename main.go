package main

import (
	"goread/ui"
)

/**
 * @author: zhashut
 * Date: 2025/4/12
 * Time: 18:55
 * Description: 主程序入口
 */

// createMainWindow 创建主窗口实例
func createMainWindow() *ui.MainWindow {
	app := ui.NewMainWindow()
	return app
}

func main() {
	// 创建主窗口
	app := createMainWindow()

	// 显示并运行主窗口
	app.ShowAndRun()
}
