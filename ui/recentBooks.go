package ui

import (
	"fmt"
	"image/color"

	"goread/bass"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

/**
 * @author: zhashut
 * Date: 2025/4/12
 * Time: 20:54
 * Description: 最近阅读视图
 */

// RecentBooksView 最近阅读视图结构体
type RecentBooksView struct {
	booker    *bass.Booker
	container *fyne.Container
}

// NewRecentBooksView 创建最近阅读视图
func NewRecentBooksView(booker *bass.Booker) *RecentBooksView {
	view := &RecentBooksView{
		booker: booker,
	}
	view.container = container.NewGridWrap(fyne.NewSize(bass.ConverW, bass.ConverH+60))
	view.Refresh() // 初始加载数据
	return view
}

// GetView 获取视图对象
func (r *RecentBooksView) GetView() fyne.CanvasObject {
	return r.container
}

// Refresh 刷新视图
func (r *RecentBooksView) Refresh() {
	r.container.Objects = nil // 清空现有内容

	// 获取最近阅读的书籍
	books := r.booker.GetRecentBooks()

	// 创建书籍卡片
	for _, book := range books {
		bookCard := r.createBookCard(book)
		r.container.Add(bookCard)
	}
}

// createBookCard 创建单个书籍卡片
func (r *RecentBooksView) createBookCard(book bass.BookMeta) fyne.CanvasObject {
	// 创建封面图片

	coverImg := canvas.NewImageFromFile(book.CoverPath)
	coverImg.FillMode = canvas.ImageFillStretch
	coverImg.SetMinSize(fyne.NewSize(bass.ConverW, bass.ConverH))

	// 创建封面边框
	coverBorder := canvas.NewRectangle(theme.DisabledColor())
	coverBorder.SetMinSize(fyne.NewSize(bass.ConverW, bass.ConverH))
	coverBorder.StrokeWidth = 1
	coverBorder.StrokeColor = theme.DisabledColor()
	coverBorder.FillColor = color.Transparent

	// 将封面和边框组合
	coverContainer := container.NewStack(coverImg, coverBorder)

	// 创建书名标签
	titleText := canvas.NewText(book.Name, color.Black)
	titleText.TextSize = theme.TextSize() - 2
	titleText.TextStyle = fyne.TextStyle{Bold: true}

	// 创建进度标签
	progressText := canvas.NewText(fmt.Sprintf("已读 %.1f%%", book.Progress), theme.ForegroundColor())
	progressText.TextSize = theme.TextSize() - 3

	// 创建垂直布局
	content := container.NewVBox(
		coverContainer,
		titleText,
		progressText,
	)

	// 创建一个可点击的容器
	clickable := &clickableCard{
		content:  content,
		filePath: book.FilePath,
		booker:   r.booker,
	}
	clickable.ExtendBaseWidget(clickable)

	return container.NewPadded(clickable)
}

// UpdateBook 更新单本书籍信息
func (r *RecentBooksView) UpdateBook(book bass.BookMeta) {
	r.Refresh() // 简单实现：刷新整个视图
}

// clickableCard 可点击的卡片组件
type clickableCard struct {
	widget.BaseWidget
	content  *fyne.Container
	filePath string
	booker   *bass.Booker
}

// CreateRenderer 实现自定义渲染
func (c *clickableCard) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(c.content)
}

// Tapped 处理点击事件
func (c *clickableCard) Tapped(*fyne.PointEvent) {
	if err := c.booker.OpenBook(c.filePath); err != nil {
		// TODO: 处理错误
	}
}
