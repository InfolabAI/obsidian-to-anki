export class LongestPath {
    private graph: { [key: string]: { [key: string]: number } };

    constructor(graph: { [key: string]: { [key: string]: number } }) {
        this.graph = graph;
    }

    public concatenatePaths(path: string[]) {
        let result = "";

        for (const item of path.reverse()) {
            result += item + "<br>";
        }

        result = result.slice(0, -6); // 맨 마지막 "<br> " 제거

        return result
    }
    public dfs(startNode: string): string {
        const visited = new Set<string>();
        const longestPath = this.dfsHelper(startNode, visited, []);

        return this.concatenatePaths(longestPath)
    }

    private dfsHelper(node: string, visited: Set<string>, path: string[]): string[] {
        visited.add(node);
        path.push(node);

        let longestPath: string[] = [];

        for (let neighbor in this.graph[node]) {
            if (!visited.has(neighbor)) {
                const newPath = this.dfsHelper(neighbor, visited, path.slice());
                if (newPath.length > longestPath.length) {
                    longestPath = newPath;
                }
            }
        }

        return longestPath.length > path.length ? longestPath : path;
    }
}