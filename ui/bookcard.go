package ui

import (
	"image/color"

	"goread/bass"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// BookCardConfig 书籍卡片配置
type BookCardConfig struct {
	CoverPath string    // 封面图片路径
	Title     string    // 书籍标题
	Progress  string    // 阅读进度文本
	FilePath  string    // 文件路径
	CoverSize fyne.Size // 封面尺寸，可选，默认使用 bass.ConverW x bass.ConverH
	OnTap     func()    // 点击回调函数，可选
}

// BookCard 书籍卡片组件
type BookCard struct {
	widget.BaseWidget
	config  BookCardConfig
	content *fyne.Container
}

// NewBookCard 创建新的书籍卡片
func NewBookCard(config BookCardConfig) *BookCard {
	card := &BookCard{
		config: config,
	}
	card.ExtendBaseWidget(card)
	card.createContent()
	return card
}

// createContent 创建卡片内容
func (c *BookCard) createContent() {
	// 设置默认封面尺寸
	if c.config.CoverSize.IsZero() {
		c.config.CoverSize = fyne.NewSize(bass.ConverW, bass.ConverH)
	}

	// 创建封面图片
	coverImg := canvas.NewImageFromFile(c.config.CoverPath)
	coverImg.FillMode = canvas.ImageFillStretch
	coverImg.SetMinSize(c.config.CoverSize)

	// 创建封面边框
	coverBorder := canvas.NewRectangle(theme.DisabledColor())
	coverBorder.SetMinSize(c.config.CoverSize)
	coverBorder.StrokeWidth = 1
	coverBorder.StrokeColor = theme.DisabledColor()
	coverBorder.FillColor = color.Transparent

	// 将封面和边框组合
	coverContainer := container.NewStack(coverImg, coverBorder)

	// 创建书名标签
	titleText := canvas.NewText(c.config.Title, color.Black)
	titleText.TextSize = theme.TextSize() - 2
	titleText.TextStyle = fyne.TextStyle{Bold: true}

	// 创建进度标签
	progressText := canvas.NewText(c.config.Progress, theme.ForegroundColor())
	progressText.TextSize = theme.TextSize() - 3

	// 创建垂直布局
	c.content = container.NewVBox(
		coverContainer,
		titleText,
		progressText,
	)
}

// CreateRenderer 实现自定义渲染
func (c *BookCard) CreateRenderer() fyne.WidgetRenderer {
	return widget.NewSimpleRenderer(container.NewPadded(c.content))
}

// Tapped 处理点击事件
func (c *BookCard) Tapped(*fyne.PointEvent) {
	if c.config.OnTap != nil {
		c.config.OnTap()
	}
}
