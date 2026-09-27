export class ArticlesService {
  findAll(query) {
    return { tag: query.tag, limit: Number(query.limit) || 10 };
  }

  create(article) {
    const { title, body } = article;
    return { title, body };
  }
}
