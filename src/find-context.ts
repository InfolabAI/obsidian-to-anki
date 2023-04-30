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
        let order = ["L3", "L2", "L1", "L0"]
        //cur L3 new note
        //cur L2 new L3
        //cur L0 new L3
        //cur L3 new L0
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