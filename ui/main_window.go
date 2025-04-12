package ui

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"goread/bass"
)

/**
 * @author: zhashut
 * Date: 2025/4/7
 * Time: 22:13
 * Description: 主界面
 */

type MainWindow struct {
	app    fyne.App    // 应用实例
	window fyne.Window // 主窗口实例
}

func NewMainWindow() *MainWindow {
	var mw MainWindow

	a := app.NewWithID(bass.PACKAGE)
	w := a.NewWindow(bass.APPNAME)
	mw.app = a
	mw.window = w
	w.Resize(fyne.Size{
		Width:  bass.WIDTH,
		Height: bass.HEIGHT,
	})

	return &mw
}

func (main *MainWindow) ShowAndRun() {
	main.window.ShowAndRun()
}
