export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const queryParams = url.searchParams;

    // 为CORS提供标准响应头
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const cacheTtl = 60 * 60 * 24 * 7; // 缓存7天
    const cache = caches.default;

    if (path === "/search") {
      const query = queryParams.get("q");
      const page = parseInt(queryParams.get("page")) || 1;
      const mode = queryParams.get("mode") || "en2zh";
      const offset = (page - 1) * 50;

      if (!query || query.trim() === "") {
        return new Response(JSON.stringify({ error: "查询参数不能为空" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (query.length > 50) {
        return new Response(JSON.stringify({ error: "搜索词长度不能超过50个字符" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const searchColumn = mode === "en2zh" ? "origin_name" : "trans_name";

      // 进阶语法解析
      function parseAdvancedQuery(raw, column) {
        let terms = [];
        let exclude = [];
        let phrase = null;
        let pattern = /"([^"]+)"|\S+/g;
        let match;
        while ((match = pattern.exec(raw)) !== null) {
          if (match[1]) {
            phrase = match[1];
          } else {
            let word = match[0];
            if (word.startsWith("-")) {
              exclude.push(word.slice(1));
            } else if (word.endsWith("*")) {
              terms.push(`${column}:${word.replace(/\*/g, "*")}`);
            } else if (word.endsWith("+")) {
              let base = word.slice(0, -1);
              terms.push(`${column}:${base}*`);
              exclude.push(base);
            } else {
              terms.push(`${column}:${word}`);
            }
          }
        }
        let fts = [];
        if (phrase) {
          fts.push(`${column}:"${phrase}"`);
        }
        if (terms.length) {
          fts.push(...terms);
        }
        if (exclude.length) {
          fts.push(...exclude.map(w => `NOT ${column}:${w}`));
        }
        return fts.join(" ");
      }

      const searchTermFts = parseAdvancedQuery(query.trim(), searchColumn);
      const exactMatchTerm = query.trim();

      const cacheKey = new Request(request.url, request);
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        const resultsQuery = `
          WITH RankedMatches AS (
            SELECT
              d.trans_name,
              d.origin_name,
              d.modid,
              d.version,
              d.key,
              d.curseforge,
              CASE
                WHEN LOWER(d.${searchColumn}) = LOWER(?) THEN 3
                WHEN dict_fts.rank = 0 THEN 2
                ELSE 1
              END AS match_weight,
              dict_fts.rank AS fts_rank,
              ROW_NUMBER() OVER (PARTITION BY d.origin_name, d.trans_name ORDER BY d.version DESC) AS rn
            FROM dict AS d
            JOIN dict_fts ON d.rowid = dict_fts.rowid
            WHERE dict_fts MATCH ?
          ),
          Frequencies AS (
            SELECT origin_name, trans_name, COUNT(*) AS frequency
            FROM RankedMatches
            GROUP BY origin_name, trans_name
          )
          SELECT
            rm.trans_name, rm.origin_name, rm.modid, rm.version, rm.key, rm.curseforge, f.frequency
          FROM RankedMatches AS rm
          JOIN Frequencies AS f ON rm.origin_name = f.origin_name AND rm.trans_name = f.trans_name
          WHERE rm.rn = 1
          ORDER BY rm.match_weight DESC, f.frequency DESC, rm.origin_name
          LIMIT 50 OFFSET ?;
        `;
        
        const countQuery = `
          SELECT COUNT(*) as total
          FROM (
            SELECT 1 FROM dict_fts
            WHERE dict_fts MATCH ?
            GROUP BY origin_name, trans_name
          );
        `;

        const [resultsData, countResult] = await Promise.all([
          env.DB.prepare(resultsQuery).bind(exactMatchTerm, searchTermFts, offset).all(),
          env.DB.prepare(countQuery).bind(searchTermFts).first()
        ]);

        const results = resultsData.results || [];
        const total = countResult ? countResult.total : 0;

        const responseData = {
          query,
          results,
          total,
          page,
          mode,
        };

        const response = new Response(JSON.stringify(responseData), {
          headers: { ...headers, "Content-Type": "application/json" },
        });

        // 将缓存操作放入后台执行，不阻塞响应返回
        ctx.waitUntil(cache.put(cacheKey, response.clone(), {
          expirationTtl: cacheTtl,
        }));

        return response;

      } catch (err) {
        console.error("Database query failed:", err);
        return new Response(JSON.stringify({ error: "数据库查询失败", details: err.message }), {
          status: 500,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404, headers });
  },
};