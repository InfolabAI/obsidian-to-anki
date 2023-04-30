export class LongestPath {
    private graph: { [key: string]: { [key: string]: number } };

    constructor(graph: { [key: string]: { [key: string]: number } }) {
        this.graph = graph;
    }

    public concatenatePaths(path: string[]) {
        let result = "";

        for (const item of path.reverse()) {
            result += item.split("/").pop() + "<br>"; // 폴더 이름 제거
        }

        result = result.slice(0, -4); // 맨 마지막 "<br> " 제거
        result = result.replaceAll(".md", ""); // .md 제거

        return result
    }
    public dfs(startNode: string): string {
        const visited = new Set<string>();
        const longestPath = this.dfsHelper(startNode, visited, []);

        return this.concatenatePaths(longestPath)
    }

    private considerHierarchy(newPath: string[]): Boolean {
        // Note 면 어떤 L3 부터 찾을 것인가가 중요하고,
        // Idea 면 어떤 L1 부터 찾을 것인가가 중요하므로,
        // L3 에서 L2 까지는 가지 않도록 하자
        let order = []
        if (-1 == ["L2", "L1"].findIndex(prefix => newPath[0].split("/").pop().startsWith(prefix))) { // 경로제거 후 match
            order = ["L3"]
        }
        else {
            order = ["L2", "L1"]
        }
        let pre_num: number = -1
        for (var path of newPath) { // 뒤로 갈수록 상위 note_level 이라고 간주하고, 뒤에 하위 note_level 이 나오면 false
            path = path.split("/").pop() // path 이므로, 파일 이름만 추출
            const std = order.findIndex(prefix => path.startsWith(prefix))
            if (pre_num > std) {
                return false
            }
            else {
                pre_num = std
            }
        }
        return true
    }

    private dfsHelper(node: string, visited: Set<string>, path: string[]): string[] {
        visited.add(node);
        path.push(node);

        let longestPath: string[] = [];

        for (let neighbor in this.graph[node]) {
            if (!visited.has(neighbor)) {
                const newPath = this.dfsHelper(neighbor, visited, path.slice());
                if (newPath.length > longestPath.length && this.considerHierarchy(newPath)) {
                    longestPath = newPath;
                }
            }
        }

        return longestPath.length > path.length ? longestPath : path;
    }
}