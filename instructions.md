I want to create chrome extension to do some automation on my browser, save html for later extract.

First it will goto save navigator of linkedin.com, https://www.linkedin.com/sales/search/company?viewAllFilters=true (html is this: data/linkedin_search.html)


 apply some filter (headquarters location, company headcount 11-50), search with keyword (Company incorporation), I will provide the list of keywords and headquaters location (those will be rotate, search next one after one to get the list), then the url will look like this:

https://www.linkedin.com/sales/search/company?query=(spellCorrectionEnabled%3Atrue%2Cfilters%3AList((type%3ACOMPANY_HEADCOUNT%2Cvalues%3AList((id%3AC%2Ctext%3A11-50%2CselectionType%3AINCLUDED)))%2C(type%3AREGION%2Cvalues%3AList((id%3A105072130%2Ctext%3APoland%2CselectionType%3AINCLUDED))))%2Ckeywords%3ACompany%2520incorporation)&sessionId=GLJ83ErvTmSbgeIEw9%2B91g%3D%3D&viewAllFilters=true


the html source code: data/linkedin_sale_navigator.html

then, in the results list, i want to get all those results

for example, now we have 2 results: Pomerico Group, Netmedia S.A.

I want to click to that link: <a id="ember1011" class="ember-view link--mercado" data-anonymize="company-name" data-control-name="view_company_via_result_name" data-control-id="È4$oÉD
³Àõ	" href="/sales/company/10457276?_ntb=GLJ83ErvTmSbgeIEw9%2B91g%3D%3D" data-sales-action="">
          Pomerico Group
        </a>

Then the url is: https://www.linkedin.com/sales/company/10457276?_ntb=GLJ83ErvTmSbgeIEw9%2B91g%3D%3D

html source code is: data/linkedin_company_detail.html

i want to get that data, for further extract, or you can extract for me the data as below if possible
Company Name	LinkedIn URL	No. Employees	Country	Industry	Company website	Company Email

Then, in the company page, there's link to Decision makers, please click to it, it will list the people that make decision: data/linkedin_decision_makers_list.html

Then, there's list, currently for this company, only one person: Sebastian Kunc, Please view profile of this person and get html source code for extracting furthur later. Or these data:
Name	Title	Email	Phone	Profile URL
