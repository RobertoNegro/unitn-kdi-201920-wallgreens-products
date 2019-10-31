const puppeteer = require('puppeteer');
const stringSimilarity = require('string-similarity');
const pg = require('pg');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const BASE_URL = 'https://www.walgreens.com';

class Main {
  static browser;
  static pool;
  static csvWriter;

  static async init () {
    this.browser = await puppeteer.launch();

    const config = {
      user: 'user',
      database: 'drugcentral',
      password: 'password',
      port: 5432,
      host: '127.0.0.1',
    };
    this.pool = new pg.Pool(config);

    this.csvWriter = createCsvWriter({
      path: 'output.csv',
      header: [
        { id: 'title', title: 'TITLE' },
        { id: 'url', title: 'URL' },
        { id: 'price', title: 'PRICE' },
        { id: 'dbId', title: 'DB_ID' },
        { id: 'dbTitle', title: 'DB_TITLE' },
      ],
    });
  }

  static async deinit () {
    await this.browser.close();
  }

  static async openPage () {
    const page = await this.browser.newPage();
    //page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    return page;
  }

  static async sleepAsync (millis) {
    return new Promise((resolve => {
      setTimeout(() => {resolve();}, millis);
    }));
  }

  static async getLablesFromDb () {
    return new Promise((resolve, reject) => {
      this.pool.connect((err, client, done) => {
        if (err) console.error(err);

        client.query('SELECT id, title FROM label WHERE category LIKE \'HUMAN OTC DRUG LABEL\'',
          function (err, result) {
            if (err) reject(err);
            else {
              resolve(result.rows);
            }
          });
      });
    });
  }

  static async run () {
    await this.init();

    const labels = await this.getLablesFromDb();

    let lastTime = (new Date()).getTime();

    const startIndex = 1000;
    const endIndex = labels.length;

    for (let i = startIndex; i < endIndex; i++) {
      const dbTitle = labels[i].title;
      const dbId = labels[i].id;
      let foundProduct = null;
      try {
        foundProduct = await this.searchProduct(dbTitle);
      } catch (err) {
        console.error(err);
      }

      if (foundProduct) {
        foundProduct.dbId = dbId;
        foundProduct.dbTitle = dbTitle;
        await this.csvWriter.writeRecords([foundProduct]);
      }

      const finishTime = (new Date()).getTime();
      if (foundProduct) {
        console.log('[' + i + '/' + labels.length + ']', foundProduct,
          (finishTime - lastTime) + 'ms');
      } else {
        console.warn('[' + i + '/' + labels.length + ']', 'NOT FOUND',
          (finishTime - lastTime) + 'ms');
      }
      lastTime = finishTime;

      await this.sleepAsync(1000);
    }

    await this.deinit();
  }

  static async searchProduct (keyword) {
    const page = await this.openPage();

    const url = BASE_URL + '/search/results.jsp?Ntt=' + encodeURI(keyword);

    console.log('Opening: ' + url);
    await page.goto(url);

    const products = await page.evaluate(({ BASE_URL }) => {
      const result = [];

      const cards = document.querySelectorAll('.wag-product-cards');
      cards.forEach(function (card) {
        const product = {};
        const titleDOM = card.querySelector('.wag-prod-title > a');

        product.title = titleDOM ? Array.prototype.filter.call(titleDOM.childNodes,
          function (element) {
            return element.nodeType === Node.TEXT_NODE;
          }).map(function (element) {
          return element.textContent.trim();
        }).join('') : 'N.A.';

        product.url = titleDOM ? BASE_URL + titleDOM.getAttribute('href') : 'N.A.';

        const priceContainer = card.querySelector('.wag-prod-price-info');
        const priceMessage = priceContainer.querySelector('.wag-price-msg');
        const priceDOM = priceContainer.querySelector('.product__price > .product__price');

        if (priceMessage)
          product.price = priceMessage.innerText;
        else if (priceDOM) {
          product.price = Array.prototype.map.call(priceDOM.childNodes, function (element) {
            let val = null;
            switch (element.nodeType) {
              case Node.TEXT_NODE:
                val = element.textContent.trim();
                break;
              case Node.ELEMENT_NODE:
                val = element.innerText;
                break;
            }
            if (!((/^\d*$/g)).test(val))
              val = null;
            return val;
          }).filter(function (element) { return !!element; }).join('.');
        } else {
          product.price = 'N.A.';
        }
        result.push(product);
      });

      return result;
    }, { BASE_URL });

    await page.close();

    if (products && products.length > 0) {
      const productsNames = products.map(product => product.title.toLowerCase().trim());
      const similarities = stringSimilarity.findBestMatch(keyword.toLowerCase().trim(),
        productsNames);

      const selectedProduct = products[similarities.bestMatchIndex];
      selectedProduct.rating = similarities.bestMatch.rating;

      return selectedProduct;
    } else {
      return null;
    }
  }
}

(async () => {
  await Main.run();
})();
