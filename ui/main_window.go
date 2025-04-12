package ui

import (
	"goread/bass"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
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
	splitContainer := container.NewBorder(mw.controls(), nil, nil, nil, nil)
	w.SetContent(splitContainer)
	mw.app = a
	mw.window = w
	w.Resize(fyne.Size{
		Width:  bass.WIDTH,
		Height: bass.HEIGHT,
	})

	return &mw
}

func (mw *MainWindow) controls() fyne.CanvasObject {
	// 创建无背景的搜索按钮和更多选项按钮
	searchButton := &widget.Button{
		Icon:       theme.SearchIcon(),
		OnTapped:   func() {},
		Importance: widget.LowImportance,
	}

	moreButton := &widget.Button{
		Icon:       theme.MoreVerticalIcon(),
		OnTapped:   func() {},
		Importance: widget.LowImportance,
	}

	buttons := container.NewHBox(searchButton, moreButton)

	// 创建标签页
	tabs := NewTabContainer(
		NewTabItem("最近", widget.NewLabel("最近内容")),
		NewTabItem("全部", widget.NewLabel("全部内容")),
	)

	return container.NewBorder(nil, nil, nil, buttons, tabs)
}

func (mw *MainWindow) ShowAndRun() {
	mw.window.ShowAndRun()
}
