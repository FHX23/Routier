function buildWhere(query: any) {
  return { tag: query.tag, author: query.author };
}

export const listArticles = async (query: any) => {
  const where = buildWhere(query);
  return { where, take: Number(query.limit) || 10 };
};

export const createArticle = async (article: any) => {
  const { title, description, tagList } = article;
  return { title, description, tagList };
};
