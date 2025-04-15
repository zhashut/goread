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

	// 控制按钮
	searchButton *widget.Button
	moreButton   *widget.Button

	// 阅读器
	booker     *bass.Booker
	recentView *RecentBooksView
}

func NewMainWindow() *MainWindow {
	var mw MainWindow

	a := app.NewWithID(bass.PACKAGE)
	w := a.NewWindow(bass.APPNAME)

	// 初始化阅读器和视图
	// 加载示例数据
	mw.booker = bass.NewBooker(bass.BookerCallback{})
	mw.booker.LoadSampleBooks()
	mw.recentView = NewRecentBooksView(mw.booker)

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
	mw.searchButton = &widget.Button{Icon: theme.SearchIcon(), OnTapped: func() {}, Importance: widget.LowImportance}
	mw.moreButton = &widget.Button{Icon: theme.MoreVerticalIcon(), OnTapped: func() {}, Importance: widget.LowImportance}

	buttons := container.NewHBox(mw.searchButton, mw.moreButton)

	// 创建标签页
	tabs := NewTabContainer(
		NewTabItem("最近", mw.recentView.GetView()),
		NewTabItem("全部", widget.NewLabel("全部内容")),
	)

	// 创建顶部工具栏，只包含标签页头部和按钮
	toolbar := container.NewBorder(nil, nil, nil, buttons, tabs.buttonBox)

	// 返回包含工具栏和内容的垂直布局
	return container.NewBorder(toolbar, nil, nil, nil, tabs.content)
}

func (mw *MainWindow) ShowAndRun() {
	content := mw.controls()
	mw.window.SetContent(content)
	mw.window.ShowAndRun()
}
