package bass

import "time"

/**
 * @author: zhashut
 * Date: 2025/4/12
 * Time: 20:54
 * Description: 书籍元数据相关结构
 */

// BookMark 书签结构
type BookMark struct {
	Page      int       // 书签页码
	Desc      string    // 书签描述
	CreatedAt time.Time // 创建时间
}

// BookMeta 书籍元数据
type BookMeta struct {
	FilePath      string     // 文件路径
	Name          string     // 书名
	Group         string     // 所属分组
	Progress      float32    // 阅读进度（百分比）
	TotalPage     int        // 总页码
	CurrentPage   int        //  当前页码
	LastPage      int        // 上次阅读页码
	LastRead      time.Time  // 上次阅读时间
	Bookmarks     []BookMark // 书签列表
	GroupPosition int        //  分组中的排序
	ScaleFactor   float32    // 缩放比列
	CoverPath     string     // 封面图片路径
}
