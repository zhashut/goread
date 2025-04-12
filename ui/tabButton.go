package ui

import (
	"image/color"
	"time"

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
 * Time: 22:19
 * Description: 自定义的 tabButton
 */

// TabItem 标签项，包含标签的文本、图标和内容
type TabItem struct {
	Text    string            // 标签文本
	Icon    fyne.Resource     // 标签图标（可选）
	Content fyne.CanvasObject // 标签对应的内容
}

// TabContainer 标签容器，管理多个标签项
type TabContainer struct {
	widget.BaseWidget
	Items      []*TabItem      // 标签项列表
	OnSelected func(index int) // 标签选中时的回调函数
	buttons    []*tabButton    // 标签按钮列表
	content    *fyne.Container // 内容显示区域
	currentTab int             // 当前选中的标签索引
	buttonBox  *fyne.Container // 标签按钮容器
}

// NewTabContainer 创建新的标签容器
func NewTabContainer(items ...*TabItem) *TabContainer {
	tc := &TabContainer{
		Items:   items,
		content: container.NewMax(),
	}
	tc.ExtendBaseWidget(tc)
	tc.createButtons()
	if len(items) > 0 {
		tc.content.Objects = []fyne.CanvasObject{items[0].Content}
		// 默认选中第一个标签
		tc.SelectTab(0)
	}
	return tc
}

// NewTabItem 创建新的标签项
func NewTabItem(text string, content fyne.CanvasObject) *TabItem {
	return &TabItem{
		Text:    text,
		Content: content,
	}
}

// tabButton 自定义标签按钮
type tabButton struct {
	widget.Button
	isSelected bool              // 是否选中
	indicator  *canvas.Rectangle // 底部指示器
	animation  *fyne.Animation   // 过渡动画
	container  *TabContainer     // 所属的标签容器
	index      int               // 在容器中的索引
	label      *canvas.Text      // 文本标签
}

// newTabButton 创建新的标签按钮
func newTabButton(text string, icon fyne.Resource, container *TabContainer, index int) *tabButton {
	btn := &tabButton{
		container: container,
		index:     index,
	}
	btn.ExtendBaseWidget(btn)
	btn.Text = text
	btn.Icon = icon
	btn.Importance = widget.LowImportance

	// 创建文本标签
	btn.label = canvas.NewText(text, theme.ForegroundColor())

	// 创建底部指示器
	btn.indicator = canvas.NewRectangle(bass.PrimaryColor)
	btn.indicator.Hide()
	btn.indicator.Resize(fyne.NewSize(40, 2))

	// 创建动画，控制指示器的位置和透明度
	btn.animation = fyne.NewAnimation(
		time.Millisecond*350, // 增加动画时长
		func(progress float32) {
			if btn.indicator == nil {
				return
			}

			size := btn.Size()
			lineWidth := float32(40)
			targetX := (size.Width - lineWidth) / 2

			if btn.isSelected {
				// 选中时的动画
				btn.indicator.Show()
				opacity := uint8(255 * progress)
				btn.indicator.FillColor = color.NRGBA{R: bass.PrimaryColor.R, G: bass.PrimaryColor.G, B: bass.PrimaryColor.B, A: opacity}
				// 文本颜色渐变到黑色
				btn.label.Color = color.NRGBA{A: uint8(255 * progress)}
			} else {
				// 取消选中时的动画
				opacity := uint8(255 * (1 - progress))
				btn.indicator.FillColor = color.NRGBA{R: bass.PrimaryColor.R, G: bass.PrimaryColor.G, B: bass.PrimaryColor.B, A: opacity}
				if progress == 1 {
					btn.indicator.Hide()
				}
				// 文本颜色渐变回默认颜色
				btn.label.Color = theme.ForegroundColor()
			}

			btn.indicator.Move(fyne.NewPos(targetX, size.Height-2))
			btn.indicator.Refresh()
			btn.label.Refresh()
		},
	)

	return btn
}

// setSelected 设置按钮的选中状态
func (t *tabButton) setSelected(selected bool) {
	if t.isSelected == selected {
		return
	}
	t.isSelected = selected

	if t.animation != nil {
		t.animation.Stop()
		t.animation.Start()
	}

	if selected {
		if t.container != nil {
			t.container.setSelectedTab(t.index)
		}
	}
	t.Refresh()
}

// CreateRenderer 创建按钮的渲染器
func (t *tabButton) CreateRenderer() fyne.WidgetRenderer {
	rend := t.Button.CreateRenderer()
	objects := rend.Objects()
	objects = append(objects, t.indicator)
	objects = append(objects, t.label)

	return &tabButtonRenderer{
		button:         t,
		buttonRenderer: rend,
		objects:        objects,
	}
}

// tabButtonRenderer 标签按钮的渲染器
type tabButtonRenderer struct {
	button         *tabButton
	buttonRenderer fyne.WidgetRenderer
	objects        []fyne.CanvasObject
}

func (r *tabButtonRenderer) Layout(size fyne.Size) {
	r.buttonRenderer.Layout(size)

	// 设置文本位置
	if r.button.label != nil {
		textSize := r.button.label.MinSize()
		r.button.label.Resize(textSize)
		x := (size.Width - textSize.Width) / 2
		y := (size.Height - textSize.Height) / 2
		r.button.label.Move(fyne.NewPos(x, y))
	}

	// 设置指示器位置
	if r.button.indicator != nil {
		r.button.indicator.Resize(fyne.NewSize(40, 2))
		r.button.indicator.Move(fyne.NewPos((size.Width-40)/2, size.Height-2))
	}
}

func (r *tabButtonRenderer) MinSize() fyne.Size {
	return r.buttonRenderer.MinSize()
}

func (r *tabButtonRenderer) Objects() []fyne.CanvasObject {
	return r.objects
}

func (r *tabButtonRenderer) Refresh() {
	r.buttonRenderer.Refresh()
}

func (r *tabButtonRenderer) Destroy() {
	r.buttonRenderer.Destroy()
}

// createButtons 为容器创建标签按钮
func (tc *TabContainer) createButtons() {
	var buttons []fyne.CanvasObject
	for i, item := range tc.Items {
		btn := newTabButton(item.Text, item.Icon, tc, i)
		btn.OnTapped = func(index int) func() {
			return func() {
				tc.SelectTab(index)
			}
		}(i)
		tc.buttons = append(tc.buttons, btn)
		buttons = append(buttons, btn)
	}
	tc.buttonBox = container.NewHBox(buttons...)
}

// SelectTab 选择指定索引的标签
func (tc *TabContainer) SelectTab(index int) {
	if index < 0 || index >= len(tc.Items) {
		return
	}

	for i, btn := range tc.buttons {
		btn.setSelected(i == index)
	}

	tc.currentTab = index

	// 更新内容显示
	if tc.content == nil {
		tc.content = container.NewMax()
	}
	tc.content.Objects = []fyne.CanvasObject{tc.Items[index].Content}
	tc.content.Refresh()

	if tc.OnSelected != nil {
		tc.OnSelected(index)
	}
}

// setSelectedTab 内部方法，设置选中的标签
func (tc *TabContainer) setSelectedTab(index int) {
	if tc.currentTab == index {
		return
	}
	tc.SelectTab(index)
}

// CreateRenderer 创建容器的渲染器
func (tc *TabContainer) CreateRenderer() fyne.WidgetRenderer {
	if tc.content == nil {
		tc.content = container.NewMax()
	}
	return &tabContainerRenderer{
		container: tc,
		objects:   []fyne.CanvasObject{tc.buttonBox, tc.content},
	}
}

// tabContainerRenderer 标签容器的渲染器
type tabContainerRenderer struct {
	container *TabContainer
	objects   []fyne.CanvasObject
}

func (r *tabContainerRenderer) MinSize() fyne.Size {
	return r.container.buttonBox.MinSize()
}

func (r *tabContainerRenderer) Layout(size fyne.Size) {
	buttonHeight := r.container.buttonBox.MinSize().Height
	r.container.buttonBox.Resize(fyne.NewSize(size.Width, buttonHeight))
	r.container.buttonBox.Move(fyne.NewPos(0, 0))

	if r.container.content != nil {
		contentY := buttonHeight
		r.container.content.Resize(fyne.NewSize(size.Width, size.Height-contentY))
		r.container.content.Move(fyne.NewPos(0, contentY))
	}
}

func (r *tabContainerRenderer) Refresh() {
	r.container.buttonBox.Refresh()
	if r.container.content != nil {
		r.container.content.Refresh()
	}
}

func (r *tabContainerRenderer) Objects() []fyne.CanvasObject {
	return r.objects
}

func (r *tabContainerRenderer) Destroy() {}
