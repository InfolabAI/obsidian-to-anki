export class LongestPath {
    private graph: { [key: string]: { [key: string]: number } };

    constructor(graph: { [key: string]: { [key: string]: number } }) {
        this.graph = graph;
    }

    public concatenatePaths(path: string[]) {
        let result = ""
        let index = 1

        for (const item of path.reverse()) {
            let cur_md = item.split("/").pop()
            if (index % 2 == 1) {
                cur_md = `<font color=#009900>${cur_md}</font>`
            }
            result += cur_md + "<br>" // 폴더 이름 제거
            index++
        }

        result = result.slice(0, -4) // 맨 마지막 "<br> " 제거
        result = result.replaceAll(".md", "") // .md 제거

        return result
    }
    public dfs(startNode: string): string {
        const visited = new Set<string>();
        //const paths = this.dfsHelperLongestPath(startNode, visited, []);
        const paths = this.findShortestPath(startNode);

        return this.concatenatePaths(paths)
    }

    private considerHierarchyForLongestPath(newPath: string[]): Boolean {
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

    private dfsHelperLongestPath(node: string, visited: Set<string>, path: string[]): string[] {
        visited.add(node);
        path.push(node);

        let longestPath: string[] = [];

        for (let neighbor in this.graph[node]) {
            if (!visited.has(neighbor)) {
                const newPath = this.dfsHelperLongestPath(neighbor, visited, path.slice());
                if (newPath.length > longestPath.length && this.considerHierarchyForLongestPath(newPath)) {
                    longestPath = newPath;
                }
            }
        } type Graph = { [key: string]: { [key: string]: number } };

        return longestPath.length > path.length ? longestPath : path;
    }

    considerHierarchyForShortestPath(node: string, start: string): boolean {
        if (-1 == ["L2", "L1"].findIndex(prefix => start.split("/").pop().startsWith(prefix))) { // 경로제거 후 match
            return node.includes("L3. (Root)") // 시작 node 가 Note 또는 L3 라면 L3 Root 까지 찾기
        }
        else {
            return node.includes("L1. (Root)") // 시작 node 가 L2 또는 L1 이라면 L1 Root 까지 찾기
        }
    }

    private findShortestPath(start: string): string[] {
        const queue = [{ node: start, path: [start] }];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const { node, path } = queue.shift()!;
            visited.add(node);

            if (this.considerHierarchyForShortestPath(node, start)) {
                return path;
            }

            const neighbors = this.graph[node];
            if (typeof neighbors !== "undefined") { // backlink 가 없는 node 에서 error 발생하지 않도록 함
                Object.keys(neighbors).forEach((neighbor) => {
                    if (!visited.has(neighbor)) {
                        queue.push({ node: neighbor, path: [...path, neighbor] });
                    }
                });
            }
        }

        return [start]
    }
}