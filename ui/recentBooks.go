package ui

import (
	"fmt"

	"goread/bass"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
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
		bookCard := NewBookCard(BookCardConfig{
			CoverPath: book.CoverPath,
			Title:     book.Name,
			Progress:  fmt.Sprintf("已读 %.1f%%", book.Progress),
			FilePath:  book.FilePath,
			OnTap: func(filePath string) func() {
				return func() {
					if err := r.booker.OpenBook(filePath); err != nil {
						// TODO: 处理错误
					}
				}
			}(book.FilePath),
		})
		r.container.Add(bookCard)
	}
}

// UpdateBook 更新单本书籍信息
func (r *RecentBooksView) UpdateBook(book bass.BookMeta) {
	r.Refresh() // 简单实现：刷新整个视图
}
