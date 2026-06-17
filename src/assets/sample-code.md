# 代码块高亮示例

切换方式:打开 `src/App.vue`,把 `import sampleMdRaw from '@/assets/sample.md?raw'` 改
为 `import sampleMdRaw from '@/assets/sample-code.md?raw'`,重启 Tauri dev。

下面覆盖 Velo 已注册的所有 20 个 shiki 语言(对应 `LANG_OPTIONS` 里
shiki 真支持的核心集),每个代码块含足够 token(关键字 / 字符串 / 数字 /
注释)触发完整高亮,用于:
- 验证 shiki Dual Themes 集成(切 dark mode 颜色平滑过渡)
- 回归字体 / 行距 / 工具条 widget 在不同语言下的视觉一致
- QA 时一眼看出某语言高亮异常(颜色错位 / token 漏分类 / 解析崩)

## 1. JavaScript

```javascript
// Fibonacci with memoization
const cache = new Map()

function fib(n) {
  if (n < 2) return n
  if (cache.has(n)) return cache.get(n)
  const v = fib(n - 1) + fib(n - 2)
  cache.set(n, v)
  return v
}

console.log('fib(20) =', fib(20)) // 6765
```

## 2. TypeScript

```typescript
interface User {
  id: number
  name: string
  roles: ReadonlyArray<'admin' | 'editor' | 'viewer'>
}

async function fetchUser(id: number): Promise<User | null> {
  const res = await fetch(`/api/users/${id}`)
  if (!res.ok) return null
  const data = (await res.json()) as User
  return data
}

const u: User = { id: 1, name: 'Layne', roles: ['admin'] }
```

## 3. Python

```python
from dataclasses import dataclass
from typing import Iterable

@dataclass(frozen=True)
class Point:
    x: float
    y: float

def distance(a: Point, b: Point) -> float:
    return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5

points: Iterable[Point] = [Point(0, 0), Point(3, 4)]
print(distance(*points))  # 5.0
```

## 4. Go

```go
package main

import (
	"fmt"
	"sync"
)

type Counter struct {
	mu    sync.Mutex
	value int
}

func (c *Counter) Inc() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value++
}

func main() {
	c := &Counter{}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Inc() }()
	}
	wg.Wait()
	fmt.Println(c.value) // 100
}
```

## 5. Rust

```rust
use std::collections::HashMap;

fn word_count(text: &str) -> HashMap<&str, usize> {
    let mut m: HashMap<&str, usize> = HashMap::new();
    for word in text.split_whitespace() {
        *m.entry(word).or_insert(0) += 1;
    }
    m
}

fn main() {
    let s = "the quick brown fox jumps over the lazy dog";
    let counts = word_count(s);
    for (word, n) in &counts {
        println!("{word}: {n}");
    }
}
```

## 6. Java

```java
import java.util.List;
import java.util.stream.Collectors;

public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public List<String> shout(List<String> words) {
        return words.stream()
            .map(w -> w.toUpperCase() + "!")
            .collect(Collectors.toList());
    }

    public static void main(String[] args) {
        var g = new Greeter("Velo");
        System.out.println(g.shout(List.of("hello", "world")));
    }
}
```

## 7. C

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    char *name;
    int   age;
} Person;

Person *make_person(const char *name, int age) {
    Person *p = malloc(sizeof(Person));
    p->name = strdup(name);
    p->age  = age;
    return p;
}

int main(void) {
    Person *p = make_person("Layne", 30);
    printf("%s is %d years old\n", p->name, p->age);
    free(p->name);
    free(p);
    return 0;
}
```

## 8. C++

```cpp
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

template <typename T>
void print_all(const std::vector<T>& v) {
    for (const auto& x : v) {
        std::cout << x << ' ';
    }
    std::cout << '\n';
}

int main() {
    std::vector<int> nums = {3, 1, 4, 1, 5, 9, 2, 6};
    std::sort(nums.begin(), nums.end());
    print_all(nums);
    return 0;
}
```

## 9. C#

```csharp
using System;
using System.Collections.Generic;
using System.Linq;

public static class LinqDemo {
    public static IEnumerable<string> TopWords(
        this IEnumerable<string> words, int n) {
        return words
            .GroupBy(w => w.ToLowerInvariant())
            .OrderByDescending(g => g.Count())
            .Take(n)
            .Select(g => $"{g.Key} ({g.Count()})");
    }
}
```

## 10. HTML

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Velo</title>
</head>
<body>
  <main class="editor">
    <h1>Hello, <span>Velo</span>!</h1>
    <p data-state="ready">Ready to write.</p>
  </main>
</body>
</html>
```

## 11. CSS

```css
:root {
  --bg: #fff;
  --fg: #24292e;
}

.editor {
  background: var(--bg);
  color: var(--fg);
  font-size: 16px;
  line-height: 1.6;
}

.editor pre code:hover {
  background: rgba(0, 0, 0, 0.04);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #c9d1d9;
  }
}
```

## 12. SCSS

```scss
@use 'sass:math';

$primary: #0f4c81;
$radius: 6px;

.button {
  display: inline-flex;
  align-items: center;
  padding: 0.5em 1em;
  border-radius: $radius;
  background: $primary;
  color: #fff;
  transition: background 0.2s ease;

  &:hover { background: darken($primary, 8%); }
  &.is-active { box-shadow: 0 0 0 2px rgba($primary, 0.3); }
}
```

## 13. JSON

```json
{
  "name": "velo",
  "version": "0.4.3",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "tauri:dev": "tauri dev"
  },
  "dependencies": {
    "shiki": "^1.0.0",
    "vue": "^3.4.0"
  }
}
```

## 14. YAML

```yaml
# Velo 编辑器设置示例
version: 1
editor:
  fontSize: 15px
  primaryColor: "#0F4C81"
  fontFamily: "Inter, system-ui, sans-serif"
  isMacCodeBlock: false
  darkMode: false
document:
  autoSaveEnabled: true
  autoSaveOnBlur: true
recent_files:
  - /home/layne/notes/todo.md
  - /home/layne/notes/ideas.md
```

## 15. TOML

```toml
# Cargo.toml 风格示例
[package]
name = "velo"
version = "0.4.3"
edition = "2021"
authors = ["Layne"]
license = "MIT"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1", features = ["full"] }

[profile.release]
opt-level = 3
lto = "thin"
```

## 16. SQL

```sql
-- 用户最近 7 天的活跃度统计
SELECT
    u.id,
    u.name,
    COUNT(e.id)   AS event_count,
    MAX(e.at)     AS last_seen
FROM users u
LEFT JOIN events e
    ON e.user_id = u.id
   AND e.at >= NOW() - INTERVAL '7 days'
WHERE u.status = 'active'
GROUP BY u.id, u.name
HAVING COUNT(e.id) > 0
ORDER BY event_count DESC
LIMIT 50;
```

## 17. Bash

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-velo}"
BRANCH="${2:-master}"

echo ">>> fetching ${REPO}@${BRANCH}"
git fetch origin "${BRANCH}"

if ! git rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1; then
    echo "branch origin/${BRANCH} does not exist" >&2
    exit 1
fi

git checkout -B "${BRANCH}" --track "origin/${BRANCH}"
echo "OK"
```

## 18. Shell

```sh
# POSIX shell 片段
log() {
    printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$*" >&2
}

if [ -f "$HOME/.config/velo/settings.json" ]; then
    log "loading settings from $HOME/.config/velo/settings.json"
    . "$HOME/.config/velo/settings.sh"
else
    log "no settings file, using defaults"
fi
```

## 19. Markdown

```markdown
# 一级标题
## 二级标题
**粗体** / _斜体_ / ~~删除线~~ / `行内 code`

- [ ] 任务 1
- [x] 任务 2

> [!NOTE]
> Markdown 内嵌示例,验证 markdown 语法的 token 分类。
```

## 20. XML

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bookstore>
  <book category="fiction" lang="en">
    <title lang="en">The Pragmatic Programmer</title>
    <author>Hunt &amp; Thomas</author>
    <year>1999</year>
    <price currency="USD">39.95</price>
  </book>
  <book category="tech" lang="zh">
    <title lang="zh">深入理解计算机系统</title>
    <author>Randal E. Bryant</author>
    <year>2016</year>
    <price currency="CNY">139.00</price>
  </book>
</bookstore>
```
